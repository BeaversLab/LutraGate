import {
  SqlConfigStore,
  CachedConfigStore,
  createGatewayHandler,
  decryptApiKey,
  KeyResolveError,
  handleAdmin,
  importEncryptionKey,
  jsonError,
  QuotaLedger,
} from "@lutragate/core";
import type { Clock, ConfigStore, Fetcher, KeyState, LogSink, Rng } from "@lutragate/core";
import type { GatewayConfig, ProviderKey } from "@lutragate/shared";
import { loadConfig } from "./config";
import { D1AdminDb } from "./d1";
import { D1LogSink } from "./log-sink";
import type { Env } from "./env";

// （builtin-web 02）顶层 `export { VERSION }` 会让 workerd 拒绝启动——非 handler
// 的命名导出不被接受（"not of type 'function or ExportedHandler'"）。该再导出无
// 任何消费者，直接删除；版本号走 @lutragate/shared 自取。

export interface HandlerDeps {
  /** Override for tests; defaults to native fetch. */
  fetcher?: Fetcher;
  /** Config store (D1-backed); defaults to env.DB when bound, else GATEWAY_CONFIG. */
  configStore?: ConfigStore;
  /** Pre-resolved config; overrides configStore (tests / env-config path). */
  config?: GatewayConfig;
  /** Resolves a provider key's plaintext at forward time. */
  keyResolver?: (key: ProviderKey) => Promise<string> | string;
  /** Request-log sink; defaults to D1LogSink when env.DB is bound. */
  logSink?: LogSink;
  /** Caller-owned cooldown state; defaults to one InMemoryKeyState per handler. */
  keyState?: KeyState;
  /** 配额账本（quota）：null 显式禁用；缺省在 env.DB 绑定时按 isolate 惰性创建。 */
  quota?: QuotaLedger | null;
  clock?: Clock;
  rng?: Rng;
}

/**
 * Worker fetch handler: routes /admin/* to the shared admin API and
 * everything else to the shared gateway handler, wiring D1-backed
 * config/cache/log implementations around them (spec §1).
 */
export function createHandler(deps: HandlerDeps = {}) {
  // Lazily-created per-isolate singletons: D1 cache (TTL 30s), AES key and
  // the quota ledger (内存计数 + 惰性播种, ADR-0001).
  let cachedStore: CachedConfigStore | null = null;
  let encryptionKeyPromise: Promise<CryptoKey> | null = null;
  let quotaLedger: QuotaLedger | null = null;

  const ensureCachedStore = (env: Env): CachedConfigStore | null => {
    if (!env.DB) return null;
    cachedStore ??= new CachedConfigStore(new SqlConfigStore(new D1AdminDb(env.DB)));
    return cachedStore;
  };

  const ensureQuotaLedger = (env: Env): QuotaLedger | null => {
    if (deps.quota !== undefined) return deps.quota; // 测试覆盖（含显式 null）
    if (!env.DB) return null; // GATEWAY_CONFIG 路径无限额
    quotaLedger ??= new QuotaLedger({ db: new D1AdminDb(env.DB), clock: deps.clock });
    return quotaLedger;
  };

  const gatewayFor = (request: Request, env: Env, ctx?: ExecutionContext) => {
    const store = ensureCachedStore(env);
    const now = () => (deps.clock ? deps.clock.now() : Date.now());
    return createGatewayHandler({
      getConfig: async () => {
        if (deps.config) return deps.config;
        if (deps.configStore) return deps.configStore.getActiveConfig();
        if (store) return store.getActiveConfig();
        return loadConfig(env);
      },
      resolveKey: (key: ProviderKey): Promise<string> | string => {
        if (deps.keyResolver) return deps.keyResolver(key);
        if (env.DB) {
          // D1-stored keys are AES-GCM encrypted; ENCRYPTION_KEY is mandatory.
          if (!env.ENCRYPTION_KEY) {
            throw new KeyResolveError(
              "ENCRYPTION_KEY must be configured when the D1 config store is used",
            );
          }
          encryptionKeyPromise ??= importEncryptionKey(env.ENCRYPTION_KEY).catch((err) => {
            encryptionKeyPromise = null; // retry on next request
            throw err;
          });
          return encryptionKeyPromise.then((cryptoKey) =>
            decryptApiKey(cryptoKey, key.encrypted_key),
          );
        }
        // Legacy GATEWAY_CONFIG path (ticket 04): base64 plaintext keys.
        return atob(key.encrypted_key);
      },
      logSink: deps.logSink ?? (env.DB ? new D1LogSink(env.DB, { now }) : null),
      keyState: deps.keyState,
      quota: ensureQuotaLedger(env),
      // 访问控制（access-control 02）：CF-Connecting-IP 由平台注入且保证真实性；
      // 测试环境未带该头时解析为 null（已设白名单 → 403，与线上语义一致）。
      clientIp: (request) => request.headers.get("cf-connecting-ip"),
      fetcher: deps.fetcher,
      clock: deps.clock,
      rng: deps.rng,
    })(request, ctx);
  };

  return async function fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Admin plane: fully separate auth surface (PRD F5.1); must be routed
    // before the gateway handler and never accepts /v1 credentials.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      if (!env.DB) return jsonError(500, "INTERNAL", "D1 database is not bound");
      const store = ensureCachedStore(env);
      return handleAdmin(request, {
        db: new D1AdminDb(env.DB),
        credentials: {
          adminToken: env.ADMIN_TOKEN,
          cfAccessClientId: env.CF_ACCESS_CLIENT_ID,
          cfAccessClientSecret: env.CF_ACCESS_CLIENT_SECRET,
        },
        encryptionKey: env.ENCRYPTION_KEY,
        invalidate: () => store?.invalidate(),
        // 与配额账本共用同一注入时钟（ADR-0005）：today=1 的窗口起点必须与
        // 429 判定同源，测试注入 clock 时两者不会分裂。
        now: () => (deps.clock ? deps.clock.now() : Date.now()),
      });
    }

    return gatewayFor(request, env, ctx);
  };
}

export default { fetch: createHandler() } satisfies ExportedHandler<Env>;
