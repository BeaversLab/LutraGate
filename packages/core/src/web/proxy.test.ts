import { describe, expect, it } from "vitest";
import type { Provider, ProviderKey } from "@lutragate/shared";
import type { SelectedChannel } from "@lutragate/core";
import { buildAnthropicRequest, buildUpstreamRequest, forwardBuffered, forwardStreamed, InvalidBodyError, parseChatBody } from "./proxy";

const T0 = 1_731_024_000_000;
const PID = "V1StGXR8_Z5jdHi6B-myA";
const KID = "V1StGXR8_Z5jdHi6B-myC";

const channel: SelectedChannel = {
  provider: {
    id: PID, name: "a", type: "custom", endpoints: { openai: "https://a.test/v1/" }, enabled: true, weight: 1,
    cooldown_failure_threshold: 0, cooldown_ms: 0,
    created_at: T0, updated_at: T0,
  } satisfies Provider,
  key: {
    id: KID, provider_id: PID,
    encrypted_key: btoa("sk-upstream-key"),
    key_hint: "-key", enabled: true, cooldown_until: 0, failure_count: 0,
    daily_token_limit: 0, daily_request_limit: 0,
    created_at: T0, updated_at: T0,
  } satisfies ProviderKey,
  upstream_model: "a-up-model",
};

describe("parseChatBody", () => {
  it("requires a non-empty string model", () => {
    expect(parseChatBody({ model: "m" }).model).toBe("m");
    expect(() => parseChatBody({ model: "" })).toThrow(InvalidBodyError);
    expect(() => parseChatBody({})).toThrow(InvalidBodyError);
    expect(() => parseChatBody("nope")).toThrow(InvalidBodyError);
  });

  it("requires stream to be boolean when present", () => {
    expect(parseChatBody({ model: "m", stream: true }).stream).toBe(true);
    expect(() => parseChatBody({ model: "m", stream: "yes" })).toThrow(InvalidBodyError);
  });
});

describe("buildUpstreamRequest", () => {
  it("replaces the model, injects upstream auth and strips unsafe headers", async () => {
    const clientHeaders = new Headers({
      authorization: "Bearer gateway-secret",
      "content-type": "application/json",
      connection: "keep-alive",
      "x-custom": "keep-me",
    });
    const req = buildUpstreamRequest(channel, { model: "m1", messages: [] }, clientHeaders, "sk-upstream-key");
    expect(req.url).toBe("https://a.test/v1/chat/completions"); // base_url 以 /v1 结尾 → 复用版本段，不重复拼接
    expect(req.headers.get("authorization")).toBe("Bearer sk-upstream-key");
    expect(req.headers.get("x-custom")).toBe("keep-me");
    expect(req.headers.get("connection")).toBeNull();
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.json()).toEqual({ model: "a-up-model", messages: [] });
  });
});

describe("buildUpstreamRequest versioned bases", () => {
  it("reuses a trailing /v4 segment (zhipu-style endpoints)", async () => {
    const zhipuChannel = {
      ...channel,
      provider: { ...channel.provider, endpoints: { openai: "https://open.bigmodel.cn/api/coding/paas/v4" } },
    };
    const req = buildUpstreamRequest(zhipuChannel, { model: "m1" }, new Headers(), "sk-k");
    expect(req.url).toBe("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions");
  });
});

describe("forwardBuffered", () => {
  it("buffers non-streaming responses, keeping status/headers and exposing text", async () => {
    const upstream = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "9", connection: "keep-alive" },
    });
    const { response, text } = await forwardBuffered(upstream);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("connection")).toBeNull();
    expect(text).toBe('{"ok":true}');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe("forwardStreamed", () => {
  it("pipes chunks through without buffering and fires hooks", async () => {
    const chunks = ['data: {"a":1}\n\n', 'data: [DONE]\n\n'];
    const seen: string[] = [];
    let flushed = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const resp = forwardStreamed(upstream, {
      onData: (text) => seen.push(text),
      onFlush: () => {
        flushed = true;
      },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    expect(await resp.text()).toBe(chunks.join(""));
    expect(seen).toEqual(chunks);
    expect(flushed).toBe(true);
  });
});

describe("buildAnthropicRequest query passthrough (upstream-request-diff)", () => {
  const channel: SelectedChannel = {
    provider: {
      id: "V1StGXR8_Z5jdHi6B-pA1", name: "a", type: "custom",
      endpoints: { anthropic: "https://a.test" }, enabled: true, weight: 1,
      cooldown_failure_threshold: 0, cooldown_ms: 0,
      created_at: T0, updated_at: T0,
    } satisfies Provider,
    key: {
      id: "V1StGXR8_Z5jdHi6B-kA1", provider_id: "V1StGXR8_Z5jdHi6B-pA1",
      encrypted_key: btoa("sk-upstream-key"),
      key_hint: "-key", enabled: true, cooldown_until: 0, failure_count: 0,
      daily_token_limit: 0, daily_request_limit: 0, created_at: T0, updated_at: T0,
    } satisfies ProviderKey,
    upstream_model: "a-up-model",
  };
  const body = { model: "glm-4.7-flash", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };

  it("passes the client query string through verbatim", () => {
    const req = buildAnthropicRequest(channel, body, new Headers(), "sk-up", "?beta=true");
    expect(new URL(req.url).pathname).toBe("/v1/messages");
    expect(new URL(req.url).search).toBe("?beta=true");
  });

  it("keeps the URL query-free when the client sends none", () => {
    const req = buildAnthropicRequest(channel, body, new Headers(), "sk-up");
    expect(new URL(req.url).search).toBe("");
    expect(req.url).toBe("https://a.test/v1/messages");
  });
});
