import { describe, expect, it } from "vitest";
import { InMemoryKeyState, sha256Hex, type Fetcher } from "@lutragate/core";
import type { GatewayConfig } from "@lutragate/shared";
import { createHandler } from "./index";
import { loadConfig } from "./config";

// 数据面鉴权（multi-user 04）：注入含 access_keys/grants 的配置，客户端用
// lgk_ 访问 key（此处用固定测试 key，按 SHA-256 哈希入快照）。
const LGK = "lgk_test-access-key-0001";
const UID = "V1StGXR8_Z5jdHi6B-us1";
const AKID = "V1StGXR8_Z5jdHi6B-ak1";

const envConfig = {
  providers: [
    { name: "a", base_url: "https://a.test" },
    { name: "b", base_url: "https://b.test" },
  ],
  keys: [
    { provider: "a", api_key: "sk-aaaa-key-a" },
    { provider: "b", api_key: "sk-bbbb-key-b" },
  ],
  mappings: [
    { client_model: "m1", provider: "a", upstream_model: "a-up" },
    { client_model: "m1", provider: "b", upstream_model: "b-up" },
  ],
};

/** 把 base 配置补成「单用户全授权」的多用户快照。 */
function withAccessKeys(base: GatewayConfig, lgkHash: string): GatewayConfig {
  return {
    ...base,
    users: [{ id: UID, enabled: true }],
    access_keys: [{ id: AKID, user_id: UID, key_hash: lgkHash, enabled: true, daily_token_limit: 0, daily_request_limit: 0, max_concurrency: 0, expires_at: 0, ip_allowlist: [] }],
    grants: base.keys.map((k) => ({ user_id: UID, provider_key_id: k.id, daily_token_limit: 0, daily_request_limit: 0 })),
  };
}

const lgkHash = await sha256Hex(LGK);
const config = withAccessKeys(loadConfig({ GATEWAY_CONFIG: JSON.stringify(envConfig) }), lgkHash);
const singleProviderConfig = withAccessKeys(loadConfig({
  GATEWAY_CONFIG: JSON.stringify({
    providers: [envConfig.providers[0]!],
    keys: [envConfig.keys[0]!],
    mappings: [envConfig.mappings[0]!],
  }),
}), lgkHash);

function mockFetcher(outcomes: Response[]): Fetcher & { requests: Request[] } {
  const requests: Request[] = [];
  let call = 0;
  return {
    requests,
    async fetch(req: Request): Promise<Response> {
      requests.push(req.clone());
      return outcomes[Math.min(call++, outcomes.length - 1)] as Response;
    },
  };
}

function call(
  handler: ReturnType<typeof createHandler>,
  body: unknown,
  headers: Record<string, string> = {},
  path = "/v1/chat/completions",
): Promise<Response> {
  return handler(
    new Request(`http://gw${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${LGK}`, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    {},
  );
}

const baseDeps = {
  config,
  clock: { now: () => 0 },
  rng: () => 0, // deterministic: always first candidate (provider a)
};

const okBody = JSON.stringify({ choices: [{ message: { content: "hi" } }] });

describe("worker handler: routing and auth", () => {
  it("/health returns version and uptime without auth", async () => {
    const handler = createHandler(baseDeps);
    const resp = await handler(new Request("http://gw/health"), {});
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
  });

  it("unknown routes return the unified 404 error structure", async () => {
    const resp = await call(createHandler(baseDeps), {}, {}, "/nope");
    expect(resp.status).toBe(404);
    await expect(resp.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: expect.stringContaining("/nope") },
    });
  });

  it("a wrong access key returns unified 401", async () => {
    const handler = createHandler(baseDeps);
    const resp = await handler(
      new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer lgk_wrong", "content-type": "application/json" },
        body: JSON.stringify({ model: "m1" }),
      }),
      {},
    );
    expect(resp.status).toBe(401);
    await expect(resp.json()).resolves.toEqual({
      error: { code: "UNAUTHORIZED", message: expect.any(String) },
    });
  });

  it("a config without access keys rejects every /v1 request (401)", async () => {
    // 旧式配置（无 access_keys）→ 索引为空 → 一律 401。
    const handler = createHandler({
      ...baseDeps,
      config: loadConfig({ GATEWAY_CONFIG: JSON.stringify(envConfig) }),
    });
    const resp = await call(handler, { model: "m1" });
    expect(resp.status).toBe(401);
  });
});

describe("worker handler: non-streaming proxy", () => {
  it("forwards a rewritten request and returns the upstream body", async () => {
    const fetcher = mockFetcher([new Response(okBody, { status: 200, headers: { "content-type": "application/json" } })]);
    const resp = await call(createHandler({ ...baseDeps, fetcher }), { model: "m1", messages: [{ role: "user", content: "q" }] });
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ choices: [{ message: { content: "hi" } }] });

    const upstream = fetcher.requests[0]!;
    expect(upstream.url).toBe("https://a.test/v1/chat/completions");
    expect(upstream.headers.get("authorization")).toBe("Bearer sk-aaaa-key-a");
    await expect(upstream.json()).resolves.toEqual({ model: "a-up", messages: [{ role: "user", content: "q" }] });
  });

  it("does not forward the access key upstream", async () => {
    const fetcher = mockFetcher([new Response(okBody)]);
    await call(createHandler({ ...baseDeps, fetcher }), { model: "m1" });
    expect(fetcher.requests[0]!.headers.get("authorization")).not.toContain(LGK);
  });

  it("rejects a missing model with 400 BAD_REQUEST", async () => {
    const resp = await call(createHandler({ ...baseDeps, fetcher: mockFetcher([]) }), { messages: [] });
    expect(resp.status).toBe(400);
    await expect(resp.json()).resolves.toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("rejects invalid JSON with 400", async () => {
    const resp = await call(createHandler({ ...baseDeps, fetcher: mockFetcher([]) }), "{not json");
    expect(resp.status).toBe(400);
  });
});

describe("worker handler: streaming proxy", () => {
  it("pipes SSE chunks through with event-stream content type", async () => {
    const chunks = ['data: {"delta":"he"}\n\n', 'data: {"delta":"llo"}\n\n', "data: [DONE]\n\n"];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    });
    const fetcher = mockFetcher([
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ]);
    const resp = await call(createHandler({ ...baseDeps, fetcher }), { model: "m1", stream: true });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    expect(await resp.text()).toBe(chunks.join(""));
  });
});

describe("worker handler: failover", () => {
  it("switches to the backup channel when the first key fails with 5xx", async () => {
    const fetcher = mockFetcher([
      new Response("boom", { status: 500 }),
      new Response(okBody, { status: 200 }),
    ]);
    const resp = await call(
      createHandler({
        ...baseDeps,
        fetcher,
        // threshold 1 → provider a's key cools down → retry picks provider b
        keyState: new InMemoryKeyState({ threshold: 1 }),
      }),
      { model: "m1" },
    );
    expect(resp.status).toBe(200);
    expect(fetcher.requests.map((r) => r.url)).toEqual([
      "https://a.test/v1/chat/completions",
      "https://b.test/v1/chat/completions",
    ]);
  });

  it("passes an upstream 401 through untouched (no retry)", async () => {
    const upstream401 = new Response('{"error":{"message":"bad key"}}', {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const fetcher = mockFetcher([upstream401]);
    const resp = await call(createHandler({ ...baseDeps, fetcher }), { model: "m1" });
    expect(resp.status).toBe(401);
    expect(fetcher.requests).toHaveLength(1);
    await expect(resp.json()).resolves.toEqual({ error: { message: "bad key" } });
  });

  it("returns 502 UPSTREAM_ERROR when all attempts fail", async () => {
    const fetcher = mockFetcher([new Response("oops", { status: 500 })]);
    // Default threshold 3: keys never cool within 3 attempts → exhaustion → 502.
    const resp = await call(createHandler({ ...baseDeps, fetcher }), { model: "m1" });
    expect(resp.status).toBe(502);
    await expect(resp.json()).resolves.toMatchObject({ error: { code: "UPSTREAM_ERROR" } });
  });

  it("returns 503 NO_CHANNEL for an unmapped model", async () => {
    const resp = await call(createHandler({ ...baseDeps, fetcher: mockFetcher([]) }), { model: "unknown" });
    expect(resp.status).toBe(503);
    await expect(resp.json()).resolves.toMatchObject({ error: { code: "NO_CHANNEL" } });
  });

  it("returns 503 NO_CHANNEL when the single configured key cools down mid-retry", async () => {
    const handler = createHandler({
      ...baseDeps,
      config: singleProviderConfig,
      fetcher: mockFetcher([new Response("x", { status: 500 })]),
      keyState: new InMemoryKeyState({ threshold: 1 }),
    });
    const resp = await call(handler, { model: "m1" });
    expect(resp.status).toBe(503);
    await expect(resp.json()).resolves.toMatchObject({
      error: { code: "NO_CHANNEL", message: expect.stringContaining("cooldown") },
    });
  });

  it("returns 503 NO_CHANNEL when no upstream key is granted to the user", async () => {
    // 授权为空：模型映射存在但候选 key 全被过滤 → NO_CHANNEL（而非 401/500）。
    const ungranted: GatewayConfig = { ...config, grants: [] };
    const handler = createHandler({ ...baseDeps, config: ungranted, fetcher: mockFetcher([]) });
    const resp = await call(handler, { model: "m1" });
    expect(resp.status).toBe(503);
    await expect(resp.json()).resolves.toMatchObject({ error: { code: "NO_CHANNEL" } });
  });
});
