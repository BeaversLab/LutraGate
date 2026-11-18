import { describe, expect, it } from "vitest";
import type { GatewayConfig, ModelMapping, Provider, ProviderKey } from "@lutragate/shared";
import type { Fetcher } from "./ports";
import { InMemoryKeyState } from "./key-state";
import { NoChannelError, type SelectedChannel } from "./select-channel";
import { executeWithRetry } from "./execute-with-retry";

const NOW = 1_000_000;
const T0 = 1_731_024_000_000;

// Distinct 21-char nanoids.
const PID_A = "V1StGXR8_Z5jdHi6B-myA";
const PID_B = "V1StGXR8_Z5jdHi6B-myB";
const KID_A1 = "V1StGXR8_Z5jdHi6B-myC";
const KID_B1 = "V1StGXR8_Z5jdHi6B-myE";
const MID_A = "V1StGXR8_Z5jdHi6B-myF";
const MID_B = "V1StGXR8_Z5jdHi6B-myG";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: PID_A,
    name: "provider-a",
    type: "custom",
    endpoints: { openai: "https://a.example.com" },
    enabled: true,
    weight: 1,
    cooldown_failure_threshold: 0,
    cooldown_ms: 0,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

function key(overrides: Partial<ProviderKey> = {}): ProviderKey {
  return {
    id: KID_A1,
    provider_id: PID_A,
    encrypted_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    key_hint: "sk-1",
    enabled: true,
    cooldown_until: 0,
    failure_count: 0,
    daily_token_limit: 0,
    daily_request_limit: 0,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

function mapping(overrides: Partial<ModelMapping> = {}): ModelMapping {
  return {
    id: MID_A,
    client_model: "gpt-4o",
    provider_id: PID_A,
    upstream_model: "gpt-4o-2024-11-20",
    enabled: true,
    ...overrides,
  };
}

/** One provider per mapping, deterministic channel order via rng → always A first. */
function configFor(providers: Provider[], keys: ProviderKey[], mappings: ModelMapping[]): GatewayConfig {
  // 多用户快照字段与路由无关，通道选择测试统一给空集。
  return { providers, keys, mappings, users: [], access_keys: [], grants: [] };
}

const twoProviderConfig = configFor(
  [provider(), provider({ id: PID_B, name: "provider-b", endpoints: { openai: "https://b.example.com" } })],
  [key(), key({ id: KID_B1, provider_id: PID_B })],
  [mapping(), mapping({ id: MID_B, provider_id: PID_B })],
);

function buildRequest(channel: SelectedChannel): Request {
  // Encode the provider in the URL so tests can observe channel switching.
  return new Request(`${channel.provider.endpoints.openai}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test" },
    body: JSON.stringify({ model: channel.upstream_model }),
  });
}

type Outcome = Response | Error | "hang";

/** Fetcher mock playing a scripted sequence of outcomes; records received requests. */
function scriptedFetcher(outcomes: Outcome[]): Fetcher & { requests: Request[] } {
  const requests: Request[] = [];
  let call = 0;
  return {
    requests,
    async fetch(req: Request): Promise<Response> {
      requests.push(req);
      const outcome = outcomes[Math.min(call++, outcomes.length - 1)] as Outcome;
      if (outcome === "hang") {
        return new Promise<Response>(() => {
          /* never settles; core must time out */
        });
      }
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const ok = () => new Response('{"ok":true}', { status: 200 });
const status = (code: number) => new Response(`upstream ${code}`, { status: code });

const baseArgs = {
  clientModel: "gpt-4o",
  buildRequest,
  clock: { now: () => NOW },
  rng: () => 0, // deterministic: always picks the first candidate
};

describe("executeWithRetry: success paths", () => {
  it("returns the upstream response on first try without failures recorded", async () => {
    const fetcher = scriptedFetcher([ok()]);
    const keyState = new InMemoryKeyState();
    const resp = await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      keyState,
    });
    expect(resp.status).toBe(200);
    expect(fetcher.requests).toHaveLength(1);
    expect(keyState.cooldowns.size).toBe(0);
  });

  it("rewrites the upstream request per selected channel (model + provider)", async () => {
    const fetcher = scriptedFetcher([ok()]);
    await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      keyState: new InMemoryKeyState(),
    });
    const body = await fetcher.requests[0]!.json();
    expect(body.model).toBe("gpt-4o-2024-11-20");
    expect(fetcher.requests[0]!.url).toBe("https://a.example.com/v1/chat/completions");
  });
});

describe("executeWithRetry: retryable errors switch channels", () => {
  it("retries on 5xx and succeeds on the next channel", async () => {
    const fetcher = scriptedFetcher([status(500), ok()]);
    const resp = await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      // threshold 1 → A's key cools down after the first failure → retry lands on B
      keyState: new InMemoryKeyState({ threshold: 1 }),
    });
    expect(resp.status).toBe(200);
    expect(fetcher.requests.map((r) => r.url)).toEqual([
      "https://a.example.com/v1/chat/completions",
      "https://b.example.com/v1/chat/completions",
    ]);
  });

  it("retries on 429", async () => {
    const fetcher = scriptedFetcher([status(429), ok()]);
    const resp = await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      keyState: new InMemoryKeyState(),
    });
    expect(resp.status).toBe(200);
    expect(fetcher.requests).toHaveLength(2);
  });

  it("retries on network errors (thrown from fetch)", async () => {
    const fetcher = scriptedFetcher([new TypeError("fetch failed"), ok()]);
    const resp = await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      keyState: new InMemoryKeyState(),
    });
    expect(resp.status).toBe(200);
    expect(fetcher.requests).toHaveLength(2);
  });

  it("counts failures toward cooldown (threshold triggers mid-retry)", async () => {
    const fetcher = scriptedFetcher([status(500), ok()]);
    const keyState = new InMemoryKeyState({ threshold: 1 });
    const resp = await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      keyState,
    });
    expect(resp.status).toBe(200);
    // Provider A's key cooled down → retry landed on provider B.
    expect(fetcher.requests[1]!.url).toContain("b.example.com");
    expect(keyState.cooldowns.get(KID_A1)).toBe(NOW + 60_000);
  });
});

describe("executeWithRetry: non-429 4xx passthrough", () => {
  it.each([400, 401, 404, 422])("passes HTTP %s through without retry or counting", async (code) => {
    const upstream = status(code);
    const fetcher = scriptedFetcher([upstream]);
    const keyState = new InMemoryKeyState();
    const resp = await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      keyState,
    });
    expect(resp).toBe(upstream); // exact same Response object, body untouched
    expect(fetcher.requests).toHaveLength(1);
    expect(keyState.cooldowns.size).toBe(0);
  });
});

describe("executeWithRetry: exhaustion", () => {
  it("returns 502 UPSTREAM_ERROR with the last error summary after retries+1 attempts", async () => {
    const fetcher = scriptedFetcher([status(500), status(500), status(503)]);
    const resp = await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      keyState: new InMemoryKeyState(),
    });
    expect(resp.status).toBe(502);
    expect(fetcher.requests).toHaveLength(3); // default retries=2
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UPSTREAM_ERROR");
    expect(body.error.message).toContain("503");
  });

  it("honours retries: 0 → exactly one attempt", async () => {
    const fetcher = scriptedFetcher([status(500)]);
    const resp = await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      keyState: new InMemoryKeyState(),
      retries: 0,
    });
    expect(resp.status).toBe(502);
    expect(fetcher.requests).toHaveLength(1);
  });

  it("includes network error details in the summary", async () => {
    const fetcher = scriptedFetcher([new Error("boom")]);
    const resp = await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      keyState: new InMemoryKeyState(),
      retries: 0,
    });
    const body = (await resp.json()) as { error: { message: string } };
    expect(body.error.message).toContain("boom");
  });
});

describe("executeWithRetry: timeout", () => {
  it("aborts a hanging upstream after timeoutMs and retries", async () => {
    const fetcher = scriptedFetcher(["hang", ok()]);
    const resp = await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      keyState: new InMemoryKeyState(),
      timeoutMs: 20,
    });
    expect(resp.status).toBe(200);
    expect(fetcher.requests[0]!.signal.aborted).toBe(true);
  });

  it("returns 502 with timeout summary when every attempt hangs", async () => {
    const fetcher = scriptedFetcher(["hang"]);
    const resp = await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      keyState: new InMemoryKeyState(),
      retries: 1,
      timeoutMs: 20,
    });
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UPSTREAM_ERROR");
    expect(body.error.message).toContain("timed out");
    expect(fetcher.requests).toHaveLength(2);
  });
});

describe("executeWithRetry: cooldown recovery", () => {
  it("lazily recovers a cooled key once the injected clock passes cooldown_until", async () => {
    const keyState = new InMemoryKeyState({ threshold: 1, cooldownMs: 60_000 });
    let clockNow = NOW;

    // First call: the only key fails and cools down until NOW+60s; with no
    // alternative channel the next selectChannel raises ALL_COOLDOWN.
    const failing = scriptedFetcher([status(500)]);
    await expect(
      executeWithRetry({
        ...baseArgs,
        config: configFor([provider()], [key()], [mapping()]),
        fetcher: failing,
        keyState,
        clock: { now: () => clockNow },
      }),
    ).rejects.toMatchObject({ reason: "ALL_COOLDOWN" });
    expect(failing.requests).toHaveLength(1);
    expect(keyState.cooldowns.get(KID_A1)).toBe(NOW + 60_000);

    // Still cooling: NO_CHANNEL.
    const stillCooling = scriptedFetcher([ok()]);
    await expect(
      executeWithRetry({
        ...baseArgs,
        config: configFor([provider()], [key()], [mapping()]),
        fetcher: stillCooling,
        keyState,
        clock: { now: () => clockNow },
      }),
    ).rejects.toMatchObject({ reason: "ALL_COOLDOWN" });

    // Fast-forward past the cooldown: same key serves again.
    clockNow = NOW + 60_001;
    const recovered = scriptedFetcher([ok()]);
    const resp2 = await executeWithRetry({
      ...baseArgs,
      config: configFor([provider()], [key()], [mapping()]),
      fetcher: recovered,
      keyState,
      clock: { now: () => clockNow },
    });
    expect(resp2.status).toBe(200);
    expect(recovered.requests).toHaveLength(1);
  });

  it("classifies an AbortError from a well-behaved fetcher as a timeout", async () => {
    // Fetcher that rejects with AbortError as soon as its signal fires.
    const requests: Request[] = [];
    const fetcher: Fetcher = {
      async fetch(req: Request): Promise<Response> {
        requests.push(req);
        return new Promise<Response>((_, reject) => {
          req.signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      },
    };
    const resp = await executeWithRetry({
      ...baseArgs,
      config: twoProviderConfig,
      fetcher,
      keyState: new InMemoryKeyState(),
      retries: 0,
      timeoutMs: 20,
    });
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as { error: { message: string } };
    expect(body.error.message).toContain("timed out");
    expect(body.error.message).not.toContain("network error");
  });
});

describe("executeWithRetry: channel exhaustion", () => {
  it("propagates NoChannelError when no mapping exists", async () => {
    const fetcher = scriptedFetcher([ok()]);
    await expect(
      executeWithRetry({
        ...baseArgs,
        config: twoProviderConfig,
        clientModel: "unknown",
        fetcher,
        keyState: new InMemoryKeyState(),
      }),
    ).rejects.toBeInstanceOf(NoChannelError);
    expect(fetcher.requests).toHaveLength(0);
  });

  it("propagates NoChannelError when every key cools down mid-retry", async () => {
    const fetcher = scriptedFetcher([status(500)]); // single-key config
    const keyState = new InMemoryKeyState({ threshold: 1 });
    await expect(
      executeWithRetry({
        ...baseArgs,
        config: configFor([provider()], [key()], [mapping()]),
        fetcher,
        keyState,
      }),
    ).rejects.toMatchObject({ reason: "ALL_COOLDOWN" });
    expect(fetcher.requests).toHaveLength(1);
    expect(keyState.cooldowns.get(KID_A1)).toBe(NOW + 60_000);
  });
});

// ---- Provider 冷却覆盖（access-control 02）----------------------------------------

describe("executeWithRetry: provider cooldown override (access-control 02)", () => {
  const singleKeyConfig = (providerOverride: Partial<Provider>) =>
    configFor([provider(providerOverride)], [key()], [mapping()]);

  it("threshold override 1 cools the only key on the first failure → NoChannelError", async () => {
    const fetcher = scriptedFetcher([status(500)]);
    const keyState = new InMemoryKeyState(); // 实例保持全局默认（3 次）
    await expect(
      executeWithRetry({
        ...baseArgs,
        config: singleKeyConfig({ cooldown_failure_threshold: 1 }),
        fetcher,
        keyState,
      }),
    ).rejects.toBeInstanceOf(NoChannelError);
    // 第二轮 selectChannel 前该 key 已按覆盖阈值进入冷却 → 只有 1 次上游调用。
    expect(fetcher.requests).toHaveLength(1);
    expect(keyState.cooldowns.get(KID_A1)).toBe(NOW + 60_000); // 时长未覆盖 → 默认
  });

  it("cooldownMs override shapes the cooldown window (threshold default still applies)", async () => {
    const fetcher = scriptedFetcher([status(500), status(500), status(500)]);
    const keyState = new InMemoryKeyState();
    const resp = await executeWithRetry({
      ...baseArgs,
      config: singleKeyConfig({ cooldown_ms: 5_000 }),
      fetcher,
      keyState,
    });
    // 阈值回退全局默认 3：三次失败恰好把 key 推入冷却 → 502。
    expect(resp.status).toBe(502);
    expect(fetcher.requests).toHaveLength(3);
    expect(keyState.cooldowns.get(KID_A1)).toBe(NOW + 5_000);
  });

  it("0/absent overrides keep the global default (3 attempts, default 60s cooldown)", async () => {
    const fetcher = scriptedFetcher([status(500), status(500), status(500)]);
    const keyState = new InMemoryKeyState();
    const resp = await executeWithRetry({
      ...baseArgs,
      config: singleKeyConfig({ cooldown_failure_threshold: 0, cooldown_ms: 0 }),
      fetcher,
      keyState,
    });
    expect(resp.status).toBe(502);
    expect(fetcher.requests).toHaveLength(3);
    // 第 3 次失败恰好达到默认阈值 → 进入默认 60s 冷却（v1.0 行为不变）。
    expect(keyState.cooldowns.get(KID_A1)).toBe(NOW + 60_000);
  });
});
