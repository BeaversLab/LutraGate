/**
 * 凭证访问控制展示辅助（access-control，roadmap v1.2）：过期/最近使用的相对
 * 展示、凭证状态推导（启用 / 已禁用 / 已过期 / 所属用户已禁用）、日期输入 ↔
 * epoch 换算与 IP 白名单多行文本解析（CIDR 校验复用 core 匹配器，与服务端
 * 同一判定，前端拦截 + 后端 400 双保险）。
 */

import { isValidCidr } from "@lutragate/core";
import { i18n } from "../i18n";
import { formatDateTime } from "./format";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 时长粗粒度展示：<1 分钟 / N 分钟 / N 小时 / N 天（向上取整，未满即算）。
 * 文案经 i18n（UI 2.0 #19；测试环境固定 zh，产出与旧硬编码中文一致）。 */
function formatDuration(ms: number): string {
  if (ms < MINUTE) return i18n.t("duration.ltMinute");
  if (ms < HOUR) return i18n.t("duration.minutes", { n: Math.ceil(ms / MINUTE) });
  if (ms < DAY) return i18n.t("duration.hours", { n: Math.ceil(ms / HOUR) });
  return i18n.t("duration.days", { n: Math.ceil(ms / DAY) });
}

/** 过期展示：0 = 永不过期；未来 → 「3 天后过期」；过去 → 「已过期 2 天」。 */
export function formatExpiry(expiresAt: number, now = Date.now()): string {
  if (expiresAt <= 0) return i18n.t("expiry.never");
  const diff = expiresAt - now;
  return diff > 0 ? i18n.t("expiry.future", { d: formatDuration(diff) }) : i18n.t("expiry.past", { d: formatDuration(-diff) });
}

/** 过期判定：与网关快照同一边界（now ≥ expires_at 即过期）。 */
export function isExpired(expiresAt: number, now = Date.now()): boolean {
  return expiresAt > 0 && now >= expiresAt;
}

/** 最近使用展示：0 = 从未使用；相对时间，超过 30 天退回日期。 */
export function formatLastUsed(lastUsedAt: number, now = Date.now()): string {
  if (lastUsedAt <= 0) return i18n.t("lastUsed.never");
  const diff = now - lastUsedAt;
  if (diff < MINUTE) return i18n.t("lastUsed.justNow");
  if (diff < HOUR) return i18n.t("lastUsed.minutesAgo", { n: Math.floor(diff / MINUTE) });
  if (diff < DAY) return i18n.t("lastUsed.hoursAgo", { n: Math.floor(diff / HOUR) });
  if (diff < 30 * DAY) return i18n.t("lastUsed.daysAgo", { n: Math.floor(diff / DAY) });
  return new Date(lastUsedAt).toLocaleDateString();
}

/**
 * 凭证列表状态（lgk_ 与 lgm_ 统一）：所属用户已禁用 > 已过期 > 已禁用 > 启用。
 * UI 2.0 #19 起返回稳定枚举（原中文直出），展示文案由 StatusBadge 经
 * i18n（status.*）渲染。
 */
export type CredentialStatus = "active" | "disabled" | "expired" | "owner_disabled";

export function credentialStatus(options: {
  enabled: boolean;
  expires_at: number;
  /** 所属用户是否启用（lgk_ 级联；lgm_ 视图传 undefined 即不判）。 */
  ownerEnabled?: boolean;
  now?: number;
}): CredentialStatus {
  const now = options.now ?? Date.now();
  if (options.ownerEnabled === false) return "owner_disabled";
  if (isExpired(options.expires_at, now)) return "expired";
  return options.enabled ? "active" : "disabled";
}

// ---- 日期输入 ↔ epoch -----------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** epoch → 日期输入值（yyyy-mm-dd，本地时区）；0/已无效 → 空（= 永不过期）。 */
export function expiryToDateInput(expiresAt: number): string {
  if (expiresAt <= 0) return "";
  const d = new Date(expiresAt);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 日期输入值 → epoch：所选「当日结束」（23:59:59.999，本地时区）过期；
 * 空 = 0（永不过期）；非法值 = -1（调用方按错误提示，不提交）。
 */
export function dateInputToExpiry(date: string): number {
  if (date.trim() === "") return 0;
  const d = new Date(`${date}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? -1 : d.getTime();
}

// ---- IP 白名单多行输入 -----------------------------------------------------------

export type CidrListParse = { list: string[]; error: null } | { list: null; error: string };

/** 多行 CIDR 文本 → 列表：逐行 trim、去空行、去重；任一行非法即整体拦截。 */
export function parseCidrList(text: string): CidrListParse {
  const lines = [...new Set(
    text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0),
  )];
  for (const line of lines) {
    if (!isValidCidr(line)) {
      return { list: null, error: i18n.t("accessControl.invalidCidr", { line }) };
    }
  }
  return { list: lines, error: null };
}

/** epoch → 本地日期展示（吊销弹窗的创建时间等静态归属）；24 小时制统一口径。 */
export function formatDate(ts: number): string {
  return formatDateTime(ts);
}
