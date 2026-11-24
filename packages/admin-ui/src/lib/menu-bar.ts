/**
 * 菜单栏面板共享逻辑（menu-bar-usage 03）：受限 key 筛选、当日占用率与风险排序。
 * 面板窗口与主窗口共用同一 bundle；本模块零 Tauri 依赖，纯函数可单测。
 */

import type { AccessKeyRow, AdminApi, Identity, UsageRow, UserRow } from "./api";
import { indexUsageByKey, usageTokens } from "./quota";

/** 面板窗口的 surface 标记（Rust 壳以 `index.html#menu-panel` 加载第二个 Webview）。 */
export const MENU_PANEL_HASH = "#menu-panel";
/** Rust 壳在面板每次显示/托盘刷新时派发的 DOM 事件名。 */
export const MENU_PANEL_SHOWN_EVENT = "lutragate:panel-shown";
/** Rust 壳 60s 后台 tick（面板可见时跳过）派发给主窗口的 DOM 事件名。 */
export const MENU_TICK_EVENT = "lutragate:menu-tick";

/** 只有精确的 surface 标记进入面板；其他 hash 不触发。 */
export function isMenuPanelSurface(hash: string = window.location.hash): boolean {
  return hash === MENU_PANEL_HASH;
}

/** 菜单栏面板只在桌面（Tauri）壳内可达；独立 Web 构建永不进入该 surface。 */
export function menuPanelActive(desktopShell: boolean, hash: string = window.location.hash): boolean {
  return desktopShell && isMenuPanelSurface(hash);
}

// ---- 视角（menu-bar-usage 04）-------------------------------------------------

export type MenuBarScope = "self" | "global";
export const MENU_BAR_SCOPE_KEY = "lutragate.menu-bar.scope";

export interface ScopeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 普通用户恒为自己；虚拟管理员（无 user_id）只能全局；真实管理员两视角都可用。 */
export function availableScopes(identity: Identity): MenuBarScope[] {
  if (identity.role !== "administrator") return ["self"];
  return identity.id === null ? ["global"] : ["self", "global"];
}

/** 持久化值只在真实管理员两视角下生效；非法值回落到自己。 */
export function resolveScope(identity: Identity, stored: string | null): MenuBarScope {
  const available = availableScopes(identity);
  if (available.length === 1) return available[0]!;
  return stored === "global" ? "global" : "self";
}

export function loadStoredScope(storage: ScopeStorage): string | null {
  try {
    return storage.getItem(MENU_BAR_SCOPE_KEY);
  } catch {
    return null;
  }
}

export function saveStoredScope(storage: ScopeStorage, scope: MenuBarScope): void {
  try {
    storage.setItem(MENU_BAR_SCOPE_KEY, scope);
  } catch {
    // 存储不可用不影响本次会话的视角切换。
  }
}

/** 一项限额的当日用量：已用 / 限额 / 占用率（可 >100，软墙越限）。 */
export interface UsageLine {
  used: number;
  limit: number;
  percent: number;
}

/** 一把受限 key 的风险视图（按占用率排序与渲染用）。 */
export interface KeyRisk {
  id: string;
  /** 归属用户：全局视角按它分组。 */
  userId: string;
  name: string;
  keyHint: string;
  tokens: UsageLine | null;
  requests: UsageLine | null;
  exceeded: boolean;
  /** 已设限额中的最高占用率；用于排序。 */
  maxPercent: number;
}

/** 全局视角的用户分组：组内沿用 KeyRisk 排序，组间按组内最高占用率降序。 */
export interface UserGroup {
  userId: string;
  name: string;
  rows: KeyRisk[];
  maxPercent: number;
}

/** 至少一项日限额非零（0 = 不限的 key 不进面板）。 */
export function isLimitedKey(key: AccessKeyRow): boolean {
  return key.daily_token_limit > 0 || key.daily_request_limit > 0;
}

function usageLine(used: number, limit: number): UsageLine | null {
  return limit > 0 ? { used, limit, percent: (used / limit) * 100 } : null;
}

function lineExceeded(line: UsageLine | null): boolean {
  return line !== null && line.used >= line.limit;
}

/**
 * 受限 key 的风险行：用量取当日聚合（tokens = prompt + completion），
 * 超限置顶 → 最高占用率降序 → 名称稳定排序。无当日行 = 0 用量。
 */
export function limitedKeyRisks(
  keys: AccessKeyRow[],
  usageByKey: Map<string, UsageRow>,
): KeyRisk[] {
  return keys
    .filter(isLimitedKey)
    .map((key): KeyRisk => {
      const usage = usageByKey.get(key.id);
      const tokens = usageLine(usageTokens(usage), key.daily_token_limit);
      const requests = usageLine(usage?.requests ?? 0, key.daily_request_limit);
      const exceeded = lineExceeded(tokens) || lineExceeded(requests);
      const maxPercent = Math.max(tokens?.percent ?? 0, requests?.percent ?? 0);
      return {
        id: key.id,
        userId: key.user_id,
        name: key.name,
        keyHint: key.key_hint,
        tokens,
        requests,
        exceeded,
        maxPercent,
      };
    })
    .sort((a, b) =>
      Number(b.exceeded) - Number(a.exceeded)
      || b.maxPercent - a.maxPercent
      || a.name.localeCompare(b.name)
      || a.id.localeCompare(b.id));
}

/** 告警口径（固定 90% 阈值）：any 限额 ≥90% 或已超限即计入；同一 key 只计一次。 */
export function alertCount(rows: KeyRisk[]): number {
  return rows.filter((row) => row.exceeded || row.maxPercent >= 90).length;
}

/** 菜单栏短文本：无告警返回 null（清空标题）；否则「⚠ N」。 */
export function alertTitle(count: number): string | null {
  return count > 0 ? `⚠ ${count}` : null;
}

/** 当前视角的受限 key 数据（面板与后台监视共用；user 角色已由服务端范围钉定）。 */
export interface MenuBarData {
  risks: KeyRisk[];
  groups: UserGroup[];
}

export async function loadMenuBarData(
  api: AdminApi,
  identity: Identity,
  scope: MenuBarScope,
): Promise<MenuBarData> {
  const global = scope === "global";
  const [keys, usage, users] = await Promise.all([
    api.listAccessKeys(),
    api.getUsage({ group_by: "key", today: true }),
    // 用户映射只是分组标签富化；失败降级为 userId 分组。
    global ? api.listUsers().catch(() => []) : Promise.resolve([]),
  ]);
  const scoped = !global && identity.id !== null
    ? keys.filter((key) => key.user_id === identity.id)
    : keys;
  const risks = limitedKeyRisks(scoped, indexUsageByKey(usage.usage));
  return { risks, groups: global ? groupKeyRisks(risks, users) : [] };
}

export function groupKeyRisks(rows: KeyRisk[], users: UserRow[]): UserGroup[] {
  const names = new Map(users.map((u) => [u.id, u.name]));
  const groups = new Map<string, UserGroup>();
  for (const row of rows) {
    const group = groups.get(row.userId) ?? {
      userId: row.userId,
      name: names.get(row.userId) ?? row.userId,
      rows: [],
      maxPercent: 0,
    };
    group.rows.push(row);
    group.maxPercent = Math.max(group.maxPercent, row.maxPercent);
    groups.set(row.userId, group);
  }
  return [...groups.values()].sort((a, b) =>
    b.maxPercent - a.maxPercent
    || a.name.localeCompare(b.name)
    || a.userId.localeCompare(b.userId));
}
