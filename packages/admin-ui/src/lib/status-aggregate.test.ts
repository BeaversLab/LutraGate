import { describe, expect, it } from "vitest";
import type { LogRow } from "./api";
import { adminStatusTriggers, hourStatsByProvider } from "./status-aggregate";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function log(overrides: Partial<LogRow>): LogRow {
  return {
    id: "r", request_id: "q", ts: NOW - 60_000, client_model: "m1", upstream_model: null,
    provider_id: "p1", key_id: null, prompt_tokens: 1, completion_tokens: 1, latency_ms: 10,
    status: 200, error_type: null, user_id: null, access_key_id: null, ...overrides,
  };
}

describe("hourStatsByProvider", () => {
  it("aggregates requests/failures within the 1h window per provider", () => {
    const stats = hourStatsByProvider([
      log({ id: "a" }),
      log({ id: "b", status: 502 }),
      log({ id: "c", provider_id: "p2" }),
      log({ id: "d", ts: NOW - 2 * HOUR }), // 窗外
      log({ id: "e", provider_id: null, error_type: "NO_CHANNEL:no_mapping" }), // 无渠道不归属
    ], NOW);
    expect(stats.get("p1")).toEqual({ requests: 2, failures: 1 });
    expect(stats.get("p2")).toEqual({ requests: 1, failures: 0 });
    expect(stats.has("__no_provider__")).toBe(false);
  });
});

describe("adminStatusTriggers", () => {
  const providers = [{ id: "p1", name: "智谱 AI" }];
  const keys = [{ provider_id: "p1", cooldown_until: 0 }];

  it("fires nothing on a clean window", () => {
    const logs = Array.from({ length: 6 }, (_, i) => log({ id: `r${i}` }));
    expect(adminStatusTriggers(logs, keys, providers, NOW)).toEqual([]);
  });

  it("fires cooldown when a key of the provider is cooling", () => {
    const cooling = [{ provider_id: "p1", cooldown_until: NOW + 30_000 }];
    expect(adminStatusTriggers([], cooling, providers, NOW)).toEqual([
      { kind: "cooldown", providerName: "智谱 AI" },
    ]);
  });

  it("fires failure_rate only past the request floor and threshold", () => {
    // 4 次 3 失败：未达请求下限 → 不触发。
    const four = [502, 502, 502, 200].map((status, i) => log({ id: `f${i}`, status }));
    expect(adminStatusTriggers(four, keys, providers, NOW)).toEqual([]);
    // 5 次 3 失败（60%）→ 触发。
    const five = [502, 502, 502, 200, 200].map((status, i) => log({ id: `g${i}`, status }));
    expect(adminStatusTriggers(five, keys, providers, NOW)).toEqual([
      { kind: "failure_rate", providerName: "智谱 AI", requests: 5, failures: 3 },
    ]);
  });

  it("fires no_channel on the NO_CHANNEL:* error prefix regardless of provider", () => {
    const logs = [log({ id: "n", provider_id: null, error_type: "NO_CHANNEL:no_mapping" })];
    expect(adminStatusTriggers(logs, keys, providers, NOW)).toEqual([{ kind: "no_channel" }]);
    // 窗外的无渠道行不算。
    const old = [log({ id: "o", ts: NOW - 2 * HOUR, provider_id: null, error_type: "NO_CHANNEL:no_mapping" })];
    expect(adminStatusTriggers(old, keys, providers, NOW)).toEqual([]);
  });
});
