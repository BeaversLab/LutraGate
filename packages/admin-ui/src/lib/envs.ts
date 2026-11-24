/** 多环境设置（multi-env 01，spec v1.4）：具名环境列表 + 活跃环境。
 * Web = localStorage；桌面 = 环境列表落 localStorage、每环境 lgm_ 走 SecretStore 分槽
 * （槽名 `management-token:<envId>`，Rust 壳 key 参数化零改动）。
 * 旧单份 settings 与旧单槽 Keychain 条目弃用——不读不写、不做存量迁移（spec 拍板）。 */

import type { SecretStore } from "./secrets";

export interface EnvRecord {
  /** 创建时随机生成的稳定身份，永不派生自 URL；凭证槽/本地库/设置引用的唯一键。 */
  id: string;
  name: string;
  gatewayUrl: string;
}

export interface EnvStoreState {
  environments: EnvRecord[];
  activeEnvId: string | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 环境列表 storage 键：跨窗口跟随（storage 事件）用它识别环境切换（面板 ⇄ 主窗口）。 */
export const ENV_STATE_KEY = "lutragate.environments";
/** Web 路径的 lgm_ 明文分槽表（桌面降级时也落这里）；token 不进环境列表（spec）。 */
export const ENV_TOKENS_KEY = "lutragate.env-tokens";

export function emptyEnvState(): EnvStoreState {
  return { environments: [], activeEnvId: null };
}

/** 环境身份：随机生成（UUID），与 URL/名字无关（spec「环境身份」）。 */
export function newEnvId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  // 降级：老 WebView 无 randomUUID，拼接足够随机的两段。
  return `env-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function parseEnvRecord(value: unknown): EnvRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") return null;
  return {
    id: record.id,
    name: typeof record.name === "string" ? record.name : "",
    gatewayUrl: typeof record.gatewayUrl === "string" ? record.gatewayUrl : "",
  };
}

export function loadEnvState(storage: StorageLike): EnvStoreState {
  try {
    const raw = storage.getItem(ENV_STATE_KEY);
    if (raw === null) return emptyEnvState();
    const parsed = JSON.parse(raw) as { environments?: unknown; activeEnvId?: unknown };
    const environments = Array.isArray(parsed.environments)
      ? parsed.environments.map(parseEnvRecord).filter((e): e is EnvRecord => e !== null)
      : [];
    // 活跃 id 指向不存在的环境（手工改坏）→ 置空自愈，不抛错。
    const activeEnvId =
      typeof parsed.activeEnvId === "string" && environments.some((e) => e.id === parsed.activeEnvId)
        ? parsed.activeEnvId
        : null;
    return { environments, activeEnvId };
  } catch {
    return emptyEnvState();
  }
}

export function saveEnvState(storage: StorageLike, state: EnvStoreState): void {
  storage.setItem(ENV_STATE_KEY, JSON.stringify(state));
}

/** 内置 Web 只读取当前网关的环境记录，兼容此前保存的同源连接。 */
export function activeEnvOf(state: EnvStoreState, fixedGatewayUrl?: string): EnvRecord | null {
  const active = state.environments.find((e) => e.id === state.activeEnvId) ?? null;
  if (fixedGatewayUrl === undefined) return active;
  const matches = (env: EnvRecord) => normalizeBaseUrl(env.gatewayUrl) === fixedGatewayUrl;
  return active && matches(active) ? active : state.environments.find(matches) ?? null;
}

/** 新建/更新环境（按 id 后者胜，更新保序）；列表从零起步时新环境自动成为活跃（首启引导）。 */
export function upsertEnv(state: EnvStoreState, env: EnvRecord): EnvStoreState {
  const exists = state.environments.some((e) => e.id === env.id);
  const environments = exists
    ? state.environments.map((e) => (e.id === env.id ? env : e))
    : [...state.environments, env];
  return { environments, activeEnvId: state.activeEnvId ?? env.id };
}

/** 置活跃（切换）；id 未知时保持原状。 */
export function setActiveEnv(state: EnvStoreState, id: string): EnvStoreState {
  return state.environments.some((e) => e.id === id) ? { ...state, activeEnvId: id } : state;
}

/** 删除环境（列表层）；被删的是活跃环境 → 回退到剩余第一个，删空则无活跃。 */
export function removeEnv(state: EnvStoreState, id: string): EnvStoreState {
  const environments = state.environments.filter((e) => e.id !== id);
  const activeEnvId = state.activeEnvId === id ? (environments[0]?.id ?? null) : state.activeEnvId;
  return { environments, activeEnvId };
}

/** Keychain 分槽槽名：`management-token:<envId>`（spec「凭证存储」；旧单槽不读不写）。 */
export function envTokenKey(envId: string): string {
  return `management-token:${envId}`;
}

type TokenMap = Record<string, string>;

function loadTokenMap(storage: StorageLike): TokenMap {
  try {
    const raw = storage.getItem(ENV_TOKENS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const map: TokenMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value !== "") map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}

function saveTokenMap(storage: StorageLike, map: TokenMap): void {
  storage.setItem(ENV_TOKENS_KEY, JSON.stringify(map));
}

/** Web 路径：lgm_ 按环境分槽明文存 localStorage（Web 惯例，spec 故事 14）。 */
export function loadEnvToken(storage: StorageLike, envId: string): string {
  return loadTokenMap(storage)[envId] ?? "";
}

export function saveEnvToken(storage: StorageLike, envId: string, token: string): void {
  const map = loadTokenMap(storage);
  if (token === "") delete map[envId];
  else map[envId] = token;
  saveTokenMap(storage, map);
}

export interface SecureEnvTokenState {
  token: string;
  degraded: boolean;
  /** 安全存储读取失败的错误信息；null = 读取正常（含「无条目」）。 */
  readError: string | null;
}

/**
 * 桌面路径加载：lgm_ 先取 SecretStore 分槽；安全存储不可用 → 明文降级读取 + degraded 警告
 * （语义与旧 settings 缝逐环境平移）。安全副本在位或首写成功时清掉明文残留（不留双份秘密）。
 */
export async function loadEnvTokenSecure(
  secret: SecretStore,
  storage: StorageLike,
  envId: string,
): Promise<SecureEnvTokenState> {
  const plaintext = loadEnvToken(storage, envId);
  const finish = (
    token: string,
    degraded: boolean,
    readError: string | null = null,
  ): SecureEnvTokenState => ({ token, degraded, readError });
  let secureToken: string | null = null;
  try {
    secureToken = await secret.get(envTokenKey(envId));
  } catch (err) {
    // 读取失败不得静默：带回错误信息，由设置页显式提示（token 仍按明文副本降级）。
    const readError = err instanceof Error ? err.message : String(err);
    return finish(plaintext, plaintext !== "", readError);
  }
  if (secureToken !== null && secureToken !== "") {
    if (plaintext !== "") saveEnvToken(storage, envId, "");
    return finish(secureToken, false);
  }
  if (plaintext === "") return finish("", false);
  // 安全存储为空但明文分槽在位（降级副本）→ 首写 Keychain 并清明文。
  try {
    await secret.set(envTokenKey(envId), plaintext);
    saveEnvToken(storage, envId, "");
    return finish(plaintext, false);
  } catch {
    return finish(plaintext, true);
  }
}

/**
 * 桌面路径保存：lgm_ 写 SecretStore 分槽。Keychain 写入失败 → 明文降级 + degraded=true
 * （设置栏常驻警告）；写入成功 → localStorage 不留任何 lgm_ 明文。
 */
export async function saveEnvTokenSecure(
  secret: SecretStore,
  storage: StorageLike,
  envId: string,
  token: string,
): Promise<{ degraded: boolean }> {
  if (token === "") {
    // 清空（登出）：两边都清；安全存储没有可删条目不算失败。
    try {
      await secret.delete(envTokenKey(envId));
    } catch {
      /* 本地已无秘密，无需降级警告 */
    }
    saveEnvToken(storage, envId, "");
    return { degraded: false };
  }
  try {
    await secret.set(envTokenKey(envId), token);
    saveEnvToken(storage, envId, "");
    return { degraded: false };
  } catch {
    saveEnvToken(storage, envId, token);
    return { degraded: true };
  }
}

/**
 * 删除环境的凭证分槽（multi-env 04，spec「删除环境」）：Keychain 条目与可能的明文降级
 * 副本一并清除，不留孤儿秘密。secret = null（Web）时只清明文分槽。
 */
export async function deleteEnvTokenEverywhere(
  secret: SecretStore | null,
  storage: StorageLike,
  envId: string,
): Promise<void> {
  saveEnvToken(storage, envId, "");
  if (secret === null) return;
  try {
    await secret.delete(envTokenKey(envId));
  } catch {
    /* Keychain 删除失败但本地分槽已清；环境本身已被移除，不阻塞删除流程 */
  }
}

/** 规范化网关地址：去首尾空白与尾部斜杠。 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** 同源预填（builtin-web 03）：内置 Web 端（server/worker 同源端出）的网关地址
 * 默认取当前 origin——用户少填一次；桌面（tauri:/自定义协议）与 file: 形态回退空串。 */
export function defaultGatewayUrl(loc: Location = window.location): string {
  return loc.protocol === "http:" || loc.protocol === "https:" ? loc.origin : "";
}
