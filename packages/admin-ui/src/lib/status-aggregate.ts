import type { GrantRow, KeyRow, LogRow, ProviderRow } from "./api";
import { isSuccessful } from "./aggregate";
import { PROVIDER_USAGE_TYPES } from "@lutragate/core";

/** 该上游 key 的供应商类型是否支持套餐用量查询（个人盘上游卡段判渲染，一次定义两处共用）。 */
export function supportsUsage(grant: Pick<GrantRow, "provider_type">): boolean {
  return (PROVIDER_USAGE_TYPES as readonly string[]).includes(grant.provider_type);
}

/**
 * 管理盘「当前状态」区的镜像聚合纯函数（dash-status 03）。口径：近 1 小时
 * 滑窗（now - 1h 起）；失败 = !isSuccessful（与画布/历史统计同源）；无渠道
 * 行 provider_id 为空、error_type 以 NO_CHANNEL: 前缀落库（gateway log）。
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * 个人盘状态卡「最近请求」（dash-status 02）：镜像内每把访问 key 的最近一条
 * 日志，只看 24h 窗口内（超窗视为「今日无请求」，与「今日余量」同口径）；
 * 无归属行（null）不进图。
 */
export function lastRequestWithin24h(logs: LogRow[], now: number): Map<string, LogRow> {
  const cutoff = now - DAY_MS;
  const map = new Map<string, LogRow>();
  for (const l of logs) {
    if (l.access_key_id === null || l.ts < cutoff) continue;
    const cur = map.get(l.access_key_id);
    if (cur === undefined || l.ts > cur.ts) map.set(l.access_key_id, l);
  }
  return map;
}

/** 警示阈值（grill 拍板：写死不做配置）——请求 ≥5 且失败率 ≥50%。 */
export const FAILURE_RATE_MIN_REQUESTS = 5;
export const FAILURE_RATE_THRESHOLD = 0.5;

export interface ProviderHourStat {
  requests: number;
  failures: number;
}

/** 近 1h 每供应商的请求/失败数（provider_id 为空的行不归属任何供应商）。 */
export function hourStatsByProvider(logs: LogRow[], now: number): Map<string, ProviderHourStat> {
  const cutoff = now - HOUR_MS;
  const map = new Map<string, ProviderHourStat>();
  for (const l of logs) {
    if (l.provider_id === null || l.ts < cutoff) continue;
    const cur = map.get(l.provider_id) ?? { requests: 0, failures: 0 };
    cur.requests += 1;
    if (!isSuccessful(l)) cur.failures += 1;
    map.set(l.provider_id, cur);
  }
  return map;
}

/** 警示触发器（三选 N）：供应商冷却 / 失败率异常 / 无渠道请求。 */
export type AdminStatusTrigger =
  | { kind: "cooldown"; providerName: string }
  | { kind: "failure_rate"; providerName: string; requests: number; failures: number }
  | { kind: "no_channel" };

/**
 * 三触发器任一命中即亮（均不命中 → 空数组，警示条整体隐藏）：
 * ① 某供应商有 key 冷却中（冷却挂 provider_key 级，按 provider 归并）；
 * ② 近 1h 请求 ≥5 且失败率 ≥50%；
 * ③ 近 1h 有无渠道请求（NO_CHANNEL:* 前缀）。
 */
export function adminStatusTriggers(
  logs: LogRow[],
  keys: Pick<KeyRow, "provider_id" | "cooldown_until">[],
  providers: Pick<ProviderRow, "id" | "name">[],
  now: number,
): AdminStatusTrigger[] {
  const cutoff = now - HOUR_MS;
  const triggers: AdminStatusTrigger[] = [];
  const cooling = new Set(keys.filter((k) => k.cooldown_until > now).map((k) => k.provider_id));
  for (const p of providers) {
    if (cooling.has(p.id)) triggers.push({ kind: "cooldown", providerName: p.name });
  }
  const stats = hourStatsByProvider(logs, now);
  for (const p of providers) {
    const s = stats.get(p.id);
    if (s && s.requests >= FAILURE_RATE_MIN_REQUESTS && s.failures / s.requests >= FAILURE_RATE_THRESHOLD) {
      triggers.push({ kind: "failure_rate", providerName: p.name, requests: s.requests, failures: s.failures });
    }
  }
  if (logs.some((l) => l.ts >= cutoff && (l.error_type ?? "").startsWith("NO_CHANNEL"))) {
    triggers.push({ kind: "no_channel" });
  }
  return triggers;
}
