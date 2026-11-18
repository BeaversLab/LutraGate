import type { ConfigStore } from "@lutragate/core";
import type { GatewayConfig } from "@lutragate/shared";

/**
 * Config cache with TTL (spec §3.2, PRD F2.5): adapters cache ActiveConfig
 * for 30s; admin writes call invalidate() so changes apply immediately on
 * the same isolate. Other isolates pick changes up within the TTL.
 */

export const CONFIG_CACHE_TTL_MS = 30_000;

export interface CachedConfigStoreOptions {
  /** Cache lifetime in ms; default 30s. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class CachedConfigStore implements ConfigStore {
  private cached: { config: GatewayConfig; expiresAt: number } | null = null;
  private inflight: Promise<GatewayConfig> | null = null;

  constructor(
    private readonly inner: ConfigStore,
    private readonly options: CachedConfigStoreOptions = {},
  ) {}

  async getActiveConfig(): Promise<GatewayConfig> {
    const now = this.options.now ?? Date.now;
    const ttl = this.options.ttlMs ?? CONFIG_CACHE_TTL_MS;
    if (this.cached && this.cached.expiresAt > now()) {
      return this.cached.config;
    }
    // Coalesce concurrent misses into one upstream read.
    if (!this.inflight) {
      this.inflight = this.inner
        .getActiveConfig()
        .then((config) => {
          this.cached = { config, expiresAt: now() + ttl };
          return config;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  /** Proactive invalidation after admin writes (PRD F2.5). */
  invalidate(): void {
    this.cached = null;
  }
}
