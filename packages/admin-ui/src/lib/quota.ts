/**
 * 限额展示辅助（quota，roadmap v1.1）：0 = 不限的语义贯穿所有面板——
 * 空输入按 0（不限）提交；展示端 0 渲染为「不限」；余量在越限（软墙可超）
 * 时钉在 0。用量聚合的联表/口径换算也集中在这里（CONTEXT.md 计量口径：
 * tokens = prompt + completion），便于单测与 /admin/usage 直查结果对照。
 */

import type { UsageRow } from "./api";
import { i18n } from "../i18n";

/** 限额数字展示：0 → 「不限」（UI 2.0 #15 起经 i18n；测试环境固定 zh）。 */
export function formatLimit(limit: number): string {
  return limit > 0 ? limit.toLocaleString() : i18n.t("quota.unlimited");
}

/** 余量：不限为 null；越限（token 软墙允许单请求超出）钉在 0。 */
export function remaining(used: number, limit: number): number | null {
  if (limit <= 0) return null;
  return Math.max(0, limit - used);
}

/** 余量数字展示：不限 → 「不限」。 */
export function formatRemaining(rest: number | null): string {
  return rest === null ? i18n.t("quota.unlimited") : rest.toLocaleString();
}

/** 一行按 key 聚合的 token 合计（prompt + completion）。 */
export function usageTokens(usage: UsageRow | undefined): number {
  return (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
}

/** 按 key 聚合行 → access_key_id 索引（无归属行丢弃）。 */
export function indexUsageByKey(rows: UsageRow[]): Map<string, UsageRow> {
  return new Map(rows.filter((r) => r.access_key_id !== null).map((r) => [r.access_key_id!, r]));
}

/**
 * 限额输入框的值 → 非负整数：空串/非法回 0（=不限）。
 * 输入框用 type="number" min={0} step={1}，这里是提交前的兜底解析。
 */
export function parseLimitInput(value: string): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
