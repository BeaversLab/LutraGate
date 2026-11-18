/** Worker bindings (spec §3.5; ticket 05: D1-backed config). */
export interface Env {
  /**
   * JSON-encoded simplified gateway config (dev fallback, ticket 04). Legacy
   * path: it carries no access keys, so /v1/* always answers 401 — use the
   * D1 store and lgk_ access keys instead (multi-user ticket 04).
   */
  GATEWAY_CONFIG?: string;
  /** D1 database holding providers/keys/mappings (migration 0001). */
  DB?: D1Database;
  /** base64(32B) AES-GCM key for provider-key encryption (secret, spec §3.4). */
  ENCRYPTION_KEY?: string;
  /** Admin token for /admin/* when Cloudflare Access is not configured. */
  ADMIN_TOKEN?: string;
  /** Cloudflare Access service-token credentials (take priority, spec §3.5). */
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}
