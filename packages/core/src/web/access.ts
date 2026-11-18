import type { GatewayConfig } from "@lutragate/shared";
import { sha256Hex } from "./tokens";

/**
 * 数据面访问控制（multi-user ticket 04）：lgk_ 鉴权与按用户授权的路由收敛。
 * 全部基于缓存的配置快照计算——热路径不逐请求查库（spec §数据面）。
 */

/** 鉴权成功的身份：日志归属与授权过滤都以此为准。 */
export interface AccessIdentity {
  user_id: string;
  access_key_id: string;
}

/**
 * 哈希索引（spec §数据面 story 29「内存中按哈希查 key」）：按配置快照对象
 * 记忆化——快照由缓存持有（对象身份稳定），首次访问 O(n) 建表，之后每请求
 * O(1) 命中，与旧静态令牌的每请求成本持平。索引只收「启用 key + 启用用户」，
 * 被禁条目与未命中不可区分。
 */
const keyIndexByConfig = new WeakMap<GatewayConfig, Map<string, AccessIdentity>>();

function accessKeyIndex(config: GatewayConfig): Map<string, AccessIdentity> {
  let index = keyIndexByConfig.get(config);
  if (index === undefined) {
    const enabledUsers = new Set(config.users.filter((u) => u.enabled).map((u) => u.id));
    index = new Map(
      config.access_keys
        .filter((k) => k.enabled && enabledUsers.has(k.user_id))
        .map((k) => [k.key_hash, { user_id: k.user_id, access_key_id: k.id }]),
    );
    keyIndexByConfig.set(config, index);
  }
  return index;
}

/**
 * 在配置快照中按 SHA-256 哈希命中启用访问 key。生效条件 = key 启用 且
 * 所属用户启用；未命中（缺失/错误/被禁 key、被禁用户、lgm_ 串号）返回 null。
 */
export async function authenticateAccessKey(
  config: GatewayConfig,
  presented: string,
): Promise<AccessIdentity | null> {
  const hash = await sha256Hex(presented);
  return accessKeyIndex(config).get(hash) ?? null;
}

/** 该用户被授权的上游 provider_key 集合。 */
export function grantedKeyIds(config: GatewayConfig, userId: string): Set<string> {
  return new Set(config.grants.filter((g) => g.user_id === userId).map((g) => g.provider_key_id));
}

/**
 * 把候选上游 key 过滤为该用户被授权的集合（授权对用户的所有访问 key 一致）。
 * 通道选择/重试/冷却逻辑零改动——过滤发生在进入 selectChannel 之前；无候选
 * 自然落现有 NoChannelError → 503 NO_CHANNEL。
 */
export function restrictToGrants(config: GatewayConfig, userId: string): GatewayConfig {
  const granted = grantedKeyIds(config, userId);
  return { ...config, keys: config.keys.filter((k) => granted.has(k.id)) };
}

/**
 * /v1/models 与 /admin/me/grants 共用的可达模型算法：仅返回「启用 provider +
 * 启用 mapping + 该 provider 至少一把已启用且被授权的上游 key」的模型。
 */
export function reachableModels(config: GatewayConfig, userId: string): string[] {
  const granted = grantedKeyIds(config, userId);
  const enabledProviders = new Set(config.providers.filter((p) => p.enabled).map((p) => p.id));
  const providersWithGrantedKey = new Set(
    config.keys.filter((k) => k.enabled && granted.has(k.id)).map((k) => k.provider_id),
  );
  return [
    ...new Set(
      config.mappings
        .filter(
          (m) =>
            m.enabled
            && enabledProviders.has(m.provider_id)
            && providersWithGrantedKey.has(m.provider_id),
        )
        .map((m) => m.client_model),
    ),
  ].sort();
}
