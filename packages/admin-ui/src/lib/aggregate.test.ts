import { describe, expect, it } from "vitest";
import type { LogRow } from "./api";
import { NO_USER_KEY, aggregateLogs, bucketForWindow, byKeyTimeline, filterLogs, isSuccessful, percentile, rangeStart } from "./aggregate";

let seq = 0;
function log(partial: Partial<LogRow>): LogRow {
  return {
    id: `log-${seq++}`,
    request_id: "r",
    ts: 0,
    client_model: "m1",
    upstream_model: null,
    provider_id: "p1",
    key_id: null,
    prompt_tokens: null,
    completion_tokens: null,
    latency_ms: null,
    status: 200,
    error_type: null,
    user_id: null,
    access_key_id: null,
    ...partial,
  };
}

describe("filterLogs", () => {
  const logs = [
    log({ id: "a", ts: 100, client_model: "m1", provider_id: "p1" }),
    log({ id: "b", ts: 200, client_model: "m2", provider_id: "p1" }),
    log({ id: "c", ts: 300, client_model: "m1", provider_id: "p2" }),
  ];

  it("filters by model, provider and time range (inclusive)", () => {
    expect(filterLogs(logs, { model: "m1" }).map((l) => l.id)).toEqual(["a", "c"]);
    expect(filterLogs(logs, { provider: "p1" }).map((l) => l.id)).toEqual(["a", "b"]);
    expect(filterLogs(logs, { from: 200, to: 300 }).map((l) => l.id)).toEqual(["b", "c"]);
    expect(filterLogs(logs, { model: "m1", provider: "p2" }).map((l) => l.id)).toEqual(["c"]);
  });

  it("filters by user attribution (multi-user dashboards)", () => {
    const attributed = [
      log({ id: "x", user_id: "u1" }),
      log({ id: "y", user_id: "u2" }),
      log({ id: "z", user_id: null }),
    ];
    expect(filterLogs(attributed, { user: "u1" }).map((l) => l.id)).toEqual(["x"]);
  });

  // ---- 原始日志面板新增维度（desktop 05）----------------------------------------

  it("filters by access key (scene) and status code (desktop 05)", () => {
    const rows = [
      log({ id: "a", access_key_id: "k1", status: 200 }),
      log({ id: "b", access_key_id: "k2", status: 502 }),
      log({ id: "c", access_key_id: null, status: 200 }),
    ];
    expect(filterLogs(rows, { key: "k1" }).map((l) => l.id)).toEqual(["a"]);
    // 无归属行（access_key_id null）不被任何 key 筛选命中。
    expect(filterLogs(rows, { key: "k2" }).map((l) => l.id)).toEqual(["b"]);
    expect(filterLogs(rows, { status: 502 }).map((l) => l.id)).toEqual(["b"]);
    expect(filterLogs(rows, { key: "k1", status: 502 }).map((l) => l.id)).toEqual([]);
  });
});

describe("isSuccessful", () => {
  it("treats 2xx-4xx as success; 401/429/5xx count as failures", () => {
    expect(isSuccessful(log({ status: 200 }))).toBe(true);
    expect(isSuccessful(log({ status: 404 }))).toBe(true); // 上游 4xx 透传
    expect(isSuccessful(log({ status: 401 }))).toBe(false); // 鉴权失败
    expect(isSuccessful(log({ status: 429 }))).toBe(false); // 限流
    expect(isSuccessful(log({ status: 502 }))).toBe(false);
    expect(isSuccessful(log({ status: 503 }))).toBe(false);
  });
});

describe("aggregateLogs", () => {
  const HOUR = 3_600_000;
  const logs = [
    log({ id: "1", ts: 10 * HOUR, client_model: "m1", provider_id: "p1", prompt_tokens: 100, completion_tokens: 50, latency_ms: 80, status: 200 }),
    log({ id: "2", ts: 10 * HOUR + 5, client_model: "m1", provider_id: "p1", prompt_tokens: 10, completion_tokens: 5, latency_ms: 200, status: 200 }),
    log({ id: "3", ts: 11 * HOUR, client_model: "m2", provider_id: "p2", prompt_tokens: 1, completion_tokens: 1, latency_ms: 4000, status: 502, error_type: "UPSTREAM_ERROR" }),
    log({ id: "4", ts: 12 * HOUR, client_model: "m2", provider_id: "p2", latency_ms: null, status: 404 }),
  ];

  it("computes totals and success rate", () => {
    const agg = aggregateLogs(logs, HOUR);
    expect(agg.totalRequests).toBe(4);
    expect(agg.failedRequests).toBe(1);
    expect(agg.successRate).toBeCloseTo(0.75);
    expect(agg.promptTokens).toBe(111);
    expect(agg.completionTokens).toBe(56);
  });

  it("groups usage by model (sorted by requests)", () => {
    const agg = aggregateLogs(logs, HOUR);
    expect(agg.byModel.map((m) => m.model)).toEqual(["m1", "m2"]);
    expect(agg.byModel[0]).toMatchObject({ requests: 2, promptTokens: 110, completionTokens: 55 });
  });

  it("computes per-provider stats with avg/p95 latency", () => {
    const agg = aggregateLogs(logs, HOUR);
    const p1 = agg.byProvider.find((p) => p.provider === "p1")!;
    expect(p1).toMatchObject({ requests: 2, errors: 0, avgLatencyMs: 140 });
    // rank = 0.95 × (2-1) = 0.95 → 80 + (200-80)×0.95 = 194（线性插值）
    expect(p1.p95LatencyMs).toBe(194);

    const p2 = agg.byProvider.find((p) => p.provider === "p2")!;
    expect(p2).toMatchObject({ requests: 2, errors: 1, avgLatencyMs: 4000 });
  });

  it("builds latency distribution buckets", () => {
    const agg = aggregateLogs(logs, HOUR);
    expect(agg.latencyBuckets).toEqual([
      { label: "<100ms", count: 1 },
      { label: "100-300ms", count: 1 },
      { label: "300ms-1s", count: 0 },
      { label: "1-3s", count: 0 },
      { label: "≥3s", count: 1 },
    ]);
  });

  it("builds an hourly timeline covering the whole span", () => {
    const agg = aggregateLogs(logs, HOUR);
    expect(agg.timeline.map((b) => b.start)).toEqual([10 * HOUR, 11 * HOUR, 12 * HOUR]);
    expect(agg.timeline[0]).toMatchObject({ requests: 2, promptTokens: 110 });
    expect(agg.timeline[2]).toMatchObject({ requests: 1 });
  });

  it("counts failed requests per timeline bucket (dash-redesign 02 stacked bars)", () => {
    const agg = aggregateLogs(logs, HOUR);
    const totalFailed = agg.timeline.reduce((n, b) => n + b.failed, 0);
    expect(totalFailed).toBe(agg.failedRequests);
  });

  it("returns nulls and empty structures for no data", () => {
    const agg = aggregateLogs([], HOUR);
    expect(agg.successRate).toBeNull();
    expect(agg.timeline).toEqual([]);
    expect(agg.byProvider).toEqual([]);
    expect(agg.byUser).toEqual([]);
  });

  it("groups usage by user with unattributed rows under a placeholder (multi-user)", () => {
    const attributed = [
      log({ id: "1", user_id: "u1", prompt_tokens: 100, completion_tokens: 50, status: 200 }),
      log({ id: "2", user_id: "u1", prompt_tokens: 10, completion_tokens: 5, status: 502 }),
      log({ id: "3", user_id: "u2", prompt_tokens: 7, completion_tokens: 3, status: 200 }),
      log({ id: "4", user_id: null, prompt_tokens: 1, completion_tokens: 1, status: 200 }),
    ];
    const agg = aggregateLogs(attributed, HOUR);
    expect(agg.byUser).toEqual([
      { user: "u1", requests: 2, errors: 1, promptTokens: 110, completionTokens: 55 },
      { user: "u2", requests: 1, errors: 0, promptTokens: 7, completionTokens: 3 },
      { user: NO_USER_KEY, requests: 1, errors: 0, promptTokens: 1, completionTokens: 1 },
    ]);
  });
});

describe("percentile", () => {
  it("interpolates between ranks", () => {
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3); // rank 1.5 → 2.5 → round 3
    expect(percentile([5, 1], 0.95)).toBe(5);
  });

  it("handles unsorted input", () => {
    expect(percentile([30, 10, 20], 1)).toBe(30);
  });
});

describe("rangeStart", () => {
  it("maps range shortcuts to epoch-ms cutoffs", () => {
    const now = 1_000_000_000;
    expect(rangeStart("24h", now)).toBe(now - 86_400_000);
    expect(rangeStart("all", now)).toBeUndefined();
  });
});

// ---- 仪表盘增强（desktop 04）---------------------------------------------------

const DAY = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEK = 7 * DAY;

describe("bucketForWindow（自定义窗桶粒度，desktop 04）", () => {
  it("按窗宽自动切换：<2 天=小时、<60 天=天、否则=周", () => {
    expect(bucketForWindow(0, 2 * DAY - 1)).toBe(HOUR_MS); // 差 1ms 满 2 天 → 小时
    expect(bucketForWindow(0, 2 * DAY)).toBe(DAY); // 恰 2 天 → 天
    expect(bucketForWindow(0, 60 * DAY - 1)).toBe(DAY); // 差 1ms 满 60 天 → 天
    expect(bucketForWindow(0, 60 * DAY)).toBe(WEEK); // 恰 60 天 → 周
    expect(bucketForWindow(0, 365 * DAY)).toBe(WEEK); // 一年 → 周
  });
});

describe("byKeyTimeline（按场景日粒度趋势，desktop 04）", () => {
  // 本地日锚定：构造本地 12:00 的固定 ts（与实现同用 setHours 语义）。
  function atLocalDay(offsetDays: number): number {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    return d.getTime() + offsetDays * DAY;
  }
  const today = atLocalDay(0);
  const yesterday = atLocalDay(-1);

  it("多 key 叠加：日桶序列按 key 分列，requests/tokens 各自累计", () => {
    const logs = [
      log({ id: "a", ts: today + HOUR_MS, access_key_id: "k1", prompt_tokens: 10, completion_tokens: 5 }),
      log({ id: "b", ts: today + 2 * HOUR_MS, access_key_id: "k1", prompt_tokens: 1, completion_tokens: 1 }),
      log({ id: "c", ts: yesterday, access_key_id: "k2", prompt_tokens: 100, completion_tokens: 50 }),
      log({ id: "d", ts: today, access_key_id: null }), // 无归属行不进任何 key 序列
    ];
    const from = yesterday;
    const to = today + 11 * HOUR_MS;
    const series = byKeyTimeline(logs, ["k1", "k2"], from, to);

    expect(series.map((s) => s.keyId)).toEqual(["k1", "k2"]);
    // 两天的日桶（本地午夜锚定）。
    const k1 = series[0]!;
    expect(k1.points.map((p) => p.requests)).toEqual([0, 2]);
    expect(k1.points[1]!.tokens).toBe(17);
    const k2 = series[1]!;
    expect(k2.points.map((p) => p.requests)).toEqual([1, 0]);
    expect(k2.points[0]!.tokens).toBe(150);
  });

  it("空数据：序列仍在（全零点），键集合为空则无序列", () => {
    const from = yesterday;
    const to = today + 11 * HOUR_MS;
    const empty = byKeyTimeline([], ["k1"], from, to);
    expect(empty).toHaveLength(1);
    expect(empty[0]!.points.every((p) => p.requests === 0 && p.tokens === 0)).toBe(true);

    expect(byKeyTimeline([log({ id: "x", ts: today })], [], from, to)).toEqual([]);
  });

  it("窗口外的行不计入，token null 视为 0", () => {
    const logs = [
      log({ id: "in", ts: today + HOUR_MS, access_key_id: "k1", prompt_tokens: null, completion_tokens: null }),
      log({ id: "out", ts: today + 5 * DAY, access_key_id: "k1", prompt_tokens: 999, completion_tokens: 999 }),
    ];
    const series = byKeyTimeline(logs, ["k1"], yesterday, today + 11 * HOUR_MS);
    expect(series[0]!.points.reduce((n, p) => n + p.requests, 0)).toBe(1);
    expect(series[0]!.points.reduce((n, p) => n + p.tokens, 0)).toBe(0);
  });
});
