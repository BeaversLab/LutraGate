/**
 * 日志聚合纯函数（ticket 11）：Dashboard 的全部统计都从这里计算，
 * 便于单测与 SQL 直查结果对照。
 */

import type { LogRow } from "./api";

export interface LogFilter {
  model?: string;
  provider?: string;
  /** 按归属用户过滤（多用户仪表盘）。 */
  user?: string;
  /** 按访问 key（=场景）过滤（原始日志面板，desktop 05）。 */
  key?: string;
  /** 按状态码精确过滤（原始日志面板，desktop 05）。 */
  status?: number;
  /** epoch ms，含端点。 */
  from?: number;
  to?: number;
}

export function filterLogs(logs: LogRow[], filter: LogFilter): LogRow[] {
  return logs.filter((l) => {
    if (filter.model !== undefined && l.client_model !== filter.model) return false;
    if (filter.provider !== undefined && l.provider_id !== filter.provider) return false;
    if (filter.user !== undefined && l.user_id !== filter.user) return false;
    if (filter.key !== undefined && l.access_key_id !== filter.key) return false;
    if (filter.status !== undefined && l.status !== filter.status) return false;
    if (filter.from !== undefined && l.ts < filter.from) return false;
    if (filter.to !== undefined && l.ts > filter.to) return false;
    return true;
  });
}

/** provider_id 为空的日志行（NO_CHANNEL 路径）使用的占位键。 */
export const NO_PROVIDER_KEY = "（无渠道）";

/** user_id 为空的历史日志行（多用户之前）使用的占位键。 */
export const NO_USER_KEY = "（无归属）";

/**
 * 成功口径：2xx-4xx 视为成功——上游 4xx（如 404 模型不存在）是正常
 * 透传行为；但 401（网关或上游鉴权失败）与 429（限流）以及一切 5xx
 * 计为失败，更贴近"这条请求是否顺利送达并得到可用响应"。
 */
export function isSuccessful(log: LogRow): boolean {
  return log.status < 500 && log.status !== 401 && log.status !== 429;
}

export interface ModelUsage {
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

export interface UserUsage {
  /** user_id；无归属行为 NO_USER_KEY。 */
  user: string;
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ProviderStats {
  provider: string;
  requests: number;
  errors: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
}

export interface TimelineBucket {
  /** 桶起始 epoch ms。 */
  start: number;
  requests: number;
  /** 失败数（dash-redesign 02 堆叠柱：失败=!isSuccessful 口径，与 errors 同源）。 */
  failed: number;
  promptTokens: number;
  completionTokens: number;
}

export interface LatencyBucket {
  label: string;
  count: number;
}

/** 延迟分布桶边界（ms）：<100 / 100-300 / 300-1k / 1k-3k / ≥3k。 */
const LATENCY_EDGES = [100, 300, 1000, 3000];
const LATENCY_LABELS = ["<100ms", "100-300ms", "300ms-1s", "1-3s", "≥3s"];

export interface Aggregates {
  totalRequests: number;
  failedRequests: number;
  /** 0-1；无请求时为 null。 */
  successRate: number | null;
  promptTokens: number;
  completionTokens: number;
  byModel: ModelUsage[];
  byProvider: ProviderStats[];
  /** 按归属用户聚合（管理仪表盘的用户维度）。 */
  byUser: UserUsage[];
  latencyBuckets: LatencyBucket[];
  timeline: TimelineBucket[];
}

export function aggregateLogs(logs: LogRow[], bucketMs: number): Aggregates {
  const totalRequests = logs.length;
  const failedRequests = logs.filter((l) => !isSuccessful(l)).length;
  const promptTokens = sum(logs.map((l) => l.prompt_tokens ?? 0));
  const completionTokens = sum(logs.map((l) => l.completion_tokens ?? 0));

  const modelMap = new Map<string, ModelUsage>();
  for (const l of logs) {
    const entry = modelMap.get(l.client_model) ?? {
      model: l.client_model, requests: 0, promptTokens: 0, completionTokens: 0,
    };
    entry.requests += 1;
    entry.promptTokens += l.prompt_tokens ?? 0;
    entry.completionTokens += l.completion_tokens ?? 0;
    modelMap.set(l.client_model, entry);
  }

  const providerMap = new Map<string, { requests: number; errors: number; latencies: number[] }>();
  for (const l of logs) {
    const key = l.provider_id ?? NO_PROVIDER_KEY;
    const entry = providerMap.get(key) ?? { requests: 0, errors: 0, latencies: [] };
    entry.requests += 1;
    if (!isSuccessful(l)) entry.errors += 1;
    if (l.latency_ms !== null) entry.latencies.push(l.latency_ms);
    providerMap.set(key, entry);
  }
  const byProvider: ProviderStats[] = [...providerMap.entries()]
    .map(([provider, e]) => ({
      provider,
      requests: e.requests,
      errors: e.errors,
      avgLatencyMs: e.latencies.length ? Math.round(sum(e.latencies) / e.latencies.length) : null,
      p50LatencyMs: e.latencies.length ? percentile(e.latencies, 0.5) : null,
      p95LatencyMs: e.latencies.length ? percentile(e.latencies, 0.95) : null,
      p99LatencyMs: e.latencies.length ? percentile(e.latencies, 0.99) : null,
    }))
    .sort((a, b) => b.requests - a.requests);

  // 按归属用户聚合：无归属（多用户之前）的历史行落在占位键下。
  const userMap = new Map<string, { requests: number; errors: number; promptTokens: number; completionTokens: number }>();
  for (const l of logs) {
    const key = l.user_id ?? NO_USER_KEY;
    const entry = userMap.get(key) ?? { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0 };
    entry.requests += 1;
    if (!isSuccessful(l)) entry.errors += 1;
    entry.promptTokens += l.prompt_tokens ?? 0;
    entry.completionTokens += l.completion_tokens ?? 0;
    userMap.set(key, entry);
  }
  const byUser: UserUsage[] = [...userMap.entries()]
    .map(([user, e]) => ({ user, ...e }))
    .sort((a, b) => b.requests - a.requests);

  const latencyCounts = LATENCY_EDGES.map((_, i) => 0);
  let overflow = 0;
  for (const l of logs) {
    if (l.latency_ms === null) continue;
    const idx = LATENCY_EDGES.findIndex((edge) => l.latency_ms! < edge);
    if (idx === -1) overflow += 1;
    else latencyCounts[idx] = (latencyCounts[idx] ?? 0) + 1;
  }
  const latencyBuckets = LATENCY_LABELS.map((label, i) => ({
    label,
    count: i === LATENCY_LABELS.length - 1 ? overflow : latencyCounts[i]!,
  }));

  return {
    totalRequests,
    failedRequests,
    successRate: totalRequests === 0 ? null : (totalRequests - failedRequests) / totalRequests,
    promptTokens,
    completionTokens,
    byModel: [...modelMap.values()].sort((a, b) => b.requests - a.requests),
    byProvider,
    byUser,
    latencyBuckets,
    timeline: buildTimeline(logs, bucketMs),
  };
}

function buildTimeline(logs: LogRow[], bucketMs: number): TimelineBucket[] {
  if (logs.length === 0) return [];
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const l of logs) {
    minTs = Math.min(minTs, l.ts);
    maxTs = Math.max(maxTs, l.ts);
  }
  const start = Math.floor(minTs / bucketMs) * bucketMs;
  const end = Math.floor(maxTs / bucketMs) * bucketMs;
  const buckets: TimelineBucket[] = [];
  for (let t = start; t <= end; t += bucketMs) {
    buckets.push({ start: t, requests: 0, failed: 0, promptTokens: 0, completionTokens: 0 });
  }
  const index = new Map(buckets.map((b) => [b.start, b]));
  for (const l of logs) {
    const bucket = index.get(Math.floor(l.ts / bucketMs) * bucketMs);
    if (!bucket) continue;
    bucket.requests += 1;
    if (!isSuccessful(l)) bucket.failed += 1;
    bucket.promptTokens += l.prompt_tokens ?? 0;
    bucket.completionTokens += l.completion_tokens ?? 0;
  }
  return buckets;
}

/** 线性插值分位数；输入无需预排序。latency 为 null 的记录不计入。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  return Math.round(sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low));
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Dashboard 时间范围快捷选项；custom = 自定义 from/to（desktop 04）。 */
export type TimeRange = "24h" | "7d" | "30d" | "all" | "custom";

/** 时间范围快捷选项 → from 时间戳（ms）；custom 的窗口由调用方持有。 */
export function rangeStart(range: TimeRange, now: number): number | undefined {
  switch (range) {
    case "24h":
      return now - 24 * 3_600_000;
    case "7d":
      return now - 7 * 86_400_000;
    case "30d":
      return now - 30 * 86_400_000;
    case "all":
      return undefined;
    case "custom":
      return undefined;
  }
}

const DAY_MS = 86_400_000;

/** 自定义窗的桶粒度（desktop 04 spec）：约 <2 天=小时、<60 天=天、否则=周。 */
export function bucketForWindow(from: number, to: number): number {
  const width = to - from;
  if (width < 2 * DAY_MS) return 3_600_000;
  if (width < 60 * DAY_MS) return DAY_MS;
  return 7 * DAY_MS;
}

/**
 * 自定义窗日期（YYYY-MM-DD）→ epoch ms 闭区间：from 为当日本地 00:00，
 * to 为当日本地 23:59:59.999。任一缺失/非法或 from 晚于 to → null（面板忽略）。
 */
export function customWindow(fromDay: string, toDay: string): { from: number; to: number } | null {
  const from = Date.parse(`${fromDay}T00:00:00`);
  const toDayStart = Date.parse(`${toDay}T00:00:00`);
  if (Number.isNaN(from) || Number.isNaN(toDayStart) || from > toDayStart) return null;
  return { from, to: toDayStart + DAY_MS - 1 };
}

/** 快捷档的固定桶粒度（custom 档由 bucketForWindow 按窗宽自动选）。 */
const QUICK_BUCKETS: Record<Exclude<TimeRange, "custom">, number> = {
  "24h": 3_600_000,
  "7d": DAY_MS,
  "30d": DAY_MS,
  all: DAY_MS,
};

/** 生效窗口（两块仪表盘共用，desktop 04）：custom → 日期换算（未完成/非法时
 * 回退「全部」档行为）；快捷档沿用 rangeStart（all 无上界）。 */
export function effectiveWindow(
  range: TimeRange,
  customFrom: string,
  customTo: string,
  now: number,
): { from: number | undefined; to: number | undefined; bucketMs: number } {
  const customWin = range === "custom" ? customWindow(customFrom, customTo) : null;
  if (customWin !== null) {
    return { ...customWin, bucketMs: bucketForWindow(customWin.from, customWin.to) };
  }
  const quickRange: Exclude<TimeRange, "custom"> =
    range === "24h" || range === "7d" || range === "30d" ? range : "all";
  return { from: rangeStart(quickRange, now), to: undefined, bucketMs: QUICK_BUCKETS[quickRange] };
}

// ---- 按场景（key）趋势（desktop 04）---------------------------------------------

/** 单个 key 的一个日桶：请求数与 token 合计（prompt + completion）。 */
export interface KeyTrendPoint {
  /** 本地午夜锚定的桶起点（epoch ms）。 */
  start: number;
  requests: number;
  tokens: number;
}

export interface KeyTrendSeries {
  keyId: string;
  points: KeyTrendPoint[];
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 按访问 key（=场景）的日粒度趋势（desktop 04）：窗口内每天一个桶（本地日），
 * 每个 key 一条序列（全零也保留，供折线叠加）；无归属行（access_key_id null）
 * 不进任何序列；tokens = prompt + completion（null 视为 0）。
 */
export function byKeyTimeline(logs: LogRow[], keyIds: string[], from: number, to: number): KeyTrendSeries[] {
  if (keyIds.length === 0) return [];
  // 日桶推进用日历日（setHours/DST 下 23/25 小时日不会漂移锚点）；
  // 用固定 86_400_000 步进会在夏令时切换日脱离本地午夜、丢行。
  const days: number[] = [];
  for (let d = new Date(startOfLocalDay(from)); d.getTime() <= to; d.setDate(d.getDate() + 1)) {
    days.push(startOfLocalDay(d.getTime()));
  }
  const index = new Map(days.map((d, i) => [d, i]));

  const series: KeyTrendSeries[] = keyIds.map((keyId) => ({
    keyId,
    points: days.map((start) => ({ start, requests: 0, tokens: 0 })),
  }));
  const byId = new Map(series.map((s) => [s.keyId, s]));
  for (const l of logs) {
    if (l.access_key_id === null) continue;
    const s = byId.get(l.access_key_id);
    if (s === undefined) continue;
    const point = s.points[index.get(startOfLocalDay(l.ts)) ?? -1];
    if (point === undefined) continue; // 窗口外
    point.requests += 1;
    point.tokens += (l.prompt_tokens ?? 0) + (l.completion_tokens ?? 0);
  }
  return series;
}
