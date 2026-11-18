import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  CachedConfigStore,
  createGatewayHandler,
  decryptApiKey,
  handleAdmin,
  importEncryptionKey,
  GATEWAY_VERSION,
  jsonError,
  QuotaLedger,
} from "@lutragate/core";
import type { AdminCredentials } from "@lutragate/core";
import { SqliteAdminDb, SqlConfigStore, SqliteLogSink, openDb } from "./db";
import { loadEnv, type ServerEnv } from "./env";
import { loadReleaseInfo, type ReleaseInfo } from "./release";

/**
 * Bun + Hono adapter (ticket 09): same routes and shared handlers as the
 * Worker form, backed by bun:sqlite. Verifies the Port abstraction — core
 * runs unmodified on a second runtime.
 */

export interface ServerOptions {
  env?: ServerEnv;
  dbPath?: string;
  /** 发布信息（/version 注入缝，测试用）；缺省读 release-info.json，缺失回退空。 */
  releaseInfo?: ReleaseInfo;
}

export function createApp(options: ServerOptions = {}) {
  const env = options.env ?? loadEnv();
  const releaseInfo = options.releaseInfo ?? loadReleaseInfo();
  const db = openDb(options.dbPath ?? env.dbPath);
  const adminDb = new SqliteAdminDb(db);
  const cache = new CachedConfigStore(new SqlConfigStore(adminDb));
  const logSink = new SqliteLogSink(db);
  // 配额账本（quota，ADR-0001）：单进程内存计数 + 惰性播种 → Server 形态精确。
  const quota = new QuotaLedger({ db: adminDb });

  let cryptoKeyPromise: Promise<CryptoKey> | null = null;
  const gateway = createGatewayHandler({
    getConfig: () => cache.getActiveConfig(),
    resolveKey: (key) => {
      cryptoKeyPromise ??= importEncryptionKey(env.encryptionKey).catch((err) => {
        cryptoKeyPromise = null;
        throw err;
      });
      return cryptoKeyPromise.then((cryptoKey) =>
        decryptApiKey(cryptoKey, key.encrypted_key),
      );
    },
    logSink,
    quota,
    // 访问控制（access-control 02）：与 admin 面 ALLOWED_IPS 同一语义——
    // TRUST_PROXY=1 时取 XFF 第一跳，否则未知（已设白名单 → 403）。
    clientIp: (request) => clientIpFrom(request, env),
  });

  const adminCredentials = (request: Request): AdminCredentials => ({
    adminToken: env.adminToken,
    allowedIps: env.allowedIps,
    clientIp: clientIpFrom(request, env),
  });

  const app = new Hono();
  // CORS（本地 web 测试实录）：vite dev(:5173) 与网关(:8787) 跨源，管理端 fetch
  // 无 CORS 头会被浏览器整体拦掉（/admin/me 都到不了）。鉴权是 x-admin-token
  // 显式头而非 cookie——放行任意 origin 没有 CSRF 面，且服务面只绑 tailnet/回环。
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["x-admin-token", "content-type"],
      maxAge: 86400,
    }),
  );
  // Both forms: Hono's "/admin/*" does not match the bare "/admin" path.
  app.all("/admin", handleAdminRoute);
  app.all("/admin/*", handleAdminRoute);
  // 发布信息（公开，同 /health 口径——信息非敏感，服务面只绑 tailnet）：标签 +
  // HEAD 短标识。注入由部署脚本生成 release-info.json 提供（release.ts）。
  app.get("/version", (c) =>
    c.json({
      tag: releaseInfo.tag,
      commit: releaseInfo.commit,
      gateway_version: GATEWAY_VERSION,
    }),
  );

  function handleAdminRoute(c: { req: { raw: Request } }) {
    return handleAdmin(c.req.raw, {
      db: adminDb,
      credentials: adminCredentials(c.req.raw),
      encryptionKey: env.encryptionKey,
      invalidate: () => cache.invalidate(),
    });
  }
  app.all("*", (c) => gateway(c.req.raw));
  return app;
}

/**
 * Client IP for the admin allowlist: the first X-Forwarded-For hop when
 * TRUST_PROXY=1 (reverse-proxy deployment), otherwise unknown.
 */
function clientIpFrom(request: Request, env: ServerEnv): string | null {
  if (!env.trustProxy) return null;
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

// Entrypoint: `bun run src/index.ts`
if (import.meta.main) {
  const env = loadEnv();
  const app = createApp({ env });
  // 自签名证书 HTTPS（tailnet 不支持 tailscale cert 的部署形态）：给出证书对时启用
  // TLS；Bun 原生接受，WKWebView/浏览器经本机信任 CA 后直接可用，满足 macOS ATS。
  const tls =
    env.tlsCertPath !== null && env.tlsKeyPath !== null
      ? { cert: readFileSync(env.tlsCertPath, "utf8"), key: readFileSync(env.tlsKeyPath, "utf8") }
      : undefined;
  Bun.serve({ port: env.port, fetch: app.fetch, tls });
  console.log(
    `lutragate server listening on :${env.port}${tls !== undefined ? " (tls)" : ""} (db: ${env.dbPath})`,
  );
}
