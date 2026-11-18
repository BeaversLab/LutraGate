import type { AccessKeyRow, AdminApi, Identity, LogRow, ProviderRow, UserRow } from "./api";
import type { LogStore } from "./logstore";

/** Personal views never fetch administrative lists, and re-scope even a mixed admin mirror. */
export async function loadAnalysisSource(api: AdminApi, db: LogStore, identity?: Identity, from?: number, to?: number) {
  if (!identity) {
    const [providers, keys, users, logs] = await Promise.all([api.listProviders(), api.listAccessKeys(), api.listUsers(), db.listLogs(from, to)]);
    return { providers, keys, users, logs };
  }
  if (!identity.id) return { providers: [] as ProviderRow[], keys: [] as AccessKeyRow[], users: [] as UserRow[], logs: [] as LogRow[] };
  const [accessKeys, mirror] = await Promise.all([api.listAccessKeys(), db.listLogs(from, to)]);
  const own = mirror.filter(l => l.user_id === identity.id);
  const models = [...new Set(own.filter(l => l.provider_id !== null).map(l => l.upstream_model ?? l.client_model))];
  return {
    providers: models.map(model => ({ id: model, name: model, type: "custom", endpoints: {}, enabled: 1, weight: 0, cooldown_failure_threshold: 0, cooldown_ms: 0, created_at: 0, updated_at: 0 })),
    keys: accessKeys.filter(k => k.user_id === identity.id),
    users: [{ id: identity.id, name: identity.name ?? "我" }] as UserRow[],
    logs: own.map(l => ({ ...l, key_id: null, provider_id: l.provider_id === null ? null : l.upstream_model ?? l.client_model })),
  };
}
