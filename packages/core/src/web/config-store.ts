import { parseIpAllowlist } from "../cidr";
import type { ConfigStore } from "../ports";
import type { AdminDb } from "./admin";
import { GatewayConfigSchema, PROTOCOLS, type GatewayConfig, type Protocol } from "@lutragate/shared";

/**
 * SQL-backed ConfigStore shared by the D1 and bun:sqlite adapters (spec
 * §3.1/§3.3): reads provider/provider_key/model_mapping rows through the
 * AdminDb port and maps them onto the shared GatewayConfig schema. SQLite
 * INTEGER 0/1 columns surface as booleans. The multi-user snapshot (ticket
 * 04) rides along: enabled users, access-key hashes and grants are folded
 * into the same cached aggregate so the gateway hot path never queries per
 * request.
 */

interface ProviderRow {
  id: string; name: string; type?: string; enabled: number; weight: number;
  cooldown_failure_threshold: number; cooldown_ms: number;
  created_at: number; updated_at: number;
}
interface EndpointRow {
  provider_id: string; protocol: string; base_url: string;
}
interface ProviderKeyRow {
  id: string; provider_id: string; encrypted_key: string; key_hint: string;
  enabled: number; cooldown_until: number; failure_count: number;
  daily_token_limit: number; daily_request_limit: number;
  created_at: number; updated_at: number;
}
interface ModelMappingRow {
  id: string; client_model: string; provider_id: string; upstream_model: string; enabled: number;
}
interface UserRow {
  id: string; enabled: number;
}
interface AccessKeyRow {
  id: string; user_id: string; key_hash: string; enabled: number;
  daily_token_limit: number; daily_request_limit: number; max_concurrency: number;
  expires_at: number; ip_allowlist: string;
}
interface GrantRow {
  user_id: string; provider_key_id: string;
  daily_token_limit: number; daily_request_limit: number;
}

const bool = (n: number) => n !== 0;

export class SqlConfigStore implements ConfigStore {
  constructor(private readonly db: AdminDb) {}

  async getActiveConfig(): Promise<GatewayConfig> {
    const [providers, keys, mappings, endpoints, users, accessKeys, grants] = await Promise.all([
      this.db.all<ProviderRow>("SELECT * FROM provider", []),
      this.db.all<ProviderKeyRow>("SELECT * FROM provider_key", []),
      this.db.all<ModelMappingRow>("SELECT * FROM model_mapping", []),
      this.db.all<EndpointRow>("SELECT provider_id, protocol, base_url FROM provider_endpoint", []),
      this.db.all<UserRow>("SELECT id, enabled FROM user", []),
      this.db.all<AccessKeyRow>(
        "SELECT id, user_id, key_hash, enabled, daily_token_limit, daily_request_limit, max_concurrency, expires_at, ip_allowlist FROM access_key", [],
      ),
      this.db.all<GrantRow>(
        "SELECT user_id, provider_key_id, daily_token_limit, daily_request_limit FROM user_key_grant", [],
      ),
    ]);
    const endpointsByProvider = new Map<string, Partial<Record<Protocol, string>>>();
    for (const e of endpoints) {
      const map = endpointsByProvider.get(e.provider_id) ?? {};
      if ((PROTOCOLS as readonly string[]).includes(e.protocol)) map[e.protocol as Protocol] = e.base_url;
      endpointsByProvider.set(e.provider_id, map);
    }

    return GatewayConfigSchema.parse({
      providers: providers.map((r) => ({
        id: r.id, name: r.name,
        endpoints: endpointsByProvider.get(r.id) ?? {},
        type: r.type ?? "custom",
        enabled: bool(r.enabled), weight: r.weight,
        // 冷却覆盖（access-control 02）：随快照下发给 execute-with-retry 失败点。
        cooldown_failure_threshold: r.cooldown_failure_threshold, cooldown_ms: r.cooldown_ms,
        created_at: r.created_at, updated_at: r.updated_at,
      })),
      keys: keys.map((r) => ({
        id: r.id, provider_id: r.provider_id,
        encrypted_key: r.encrypted_key, key_hint: r.key_hint,
        enabled: bool(r.enabled), cooldown_until: r.cooldown_until,
        failure_count: r.failure_count,
        daily_token_limit: r.daily_token_limit, daily_request_limit: r.daily_request_limit,
        created_at: r.created_at, updated_at: r.updated_at,
      })),
      mappings: mappings.map((r) => ({
        id: r.id, client_model: r.client_model, provider_id: r.provider_id,
        upstream_model: r.upstream_model, enabled: bool(r.enabled),
      })),
      users: users.map((r) => ({ id: r.id, enabled: bool(r.enabled) })),
      access_keys: accessKeys.map((r) => ({
        id: r.id, user_id: r.user_id, key_hash: r.key_hash, enabled: bool(r.enabled),
        daily_token_limit: r.daily_token_limit, daily_request_limit: r.daily_request_limit,
        max_concurrency: r.max_concurrency,
        // access-control：过期与来源网络随快照下发热路径（ip_allowlist 列为 JSON 字符串）。
        expires_at: r.expires_at,
        ip_allowlist: parseIpAllowlist(r.ip_allowlist),
      })),
      grants: grants.map((r) => ({
        user_id: r.user_id, provider_key_id: r.provider_key_id,
        daily_token_limit: r.daily_token_limit, daily_request_limit: r.daily_request_limit,
      })),
    });
  }
}
