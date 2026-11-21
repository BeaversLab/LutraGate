import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import type { MiddlewareHandler } from "hono";
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
  /**
   * 内置 Web 管理端的静态资产目录（builtin-web 01，注入缝，测试用）。未提供 = 静态
   * 服务关闭（本地开发/纯 API 用法，原行为）；生产入口缺省探测镜像内 admin-ui dist。
   */
  assetsDir?: string | null;
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

  // 内置 Web 管理端（builtin-web 01，ADR-0004）：同源端出 admin-ui 静态产物。
  // API 优先不变式：/v1、/admin、/version、/health（含未知子路径、编码与重复斜杠
  // 变体）永远先于静态服务与 SPA 回退——回退 index.html 只接住「既非资产也非 API」
  // 的 GET/HEAD 路径。
  if (options.assetsDir !== undefined && options.assetsDir !== null) {
    const assetsRoot = options.assetsDir;
    // 判定前先解码 %XX 并折叠重复斜杠——`/v1%2ffoo`、`//v1/models` 这类变体此前
    // 由 gateway 回 JSON，不能被 SPA 回退变成 index.html。
    const isApiPath = (raw: string) => {
      let p = raw;
      try {
        p = decodeURIComponent(raw);
      } catch {
        // 非法编码：按原样参与前缀判定，不放大。
      }
      p = p.replace(/\/{2,}/g, "/");
      const under = (prefix: string) => p === prefix || p.startsWith(`${prefix}/`);
      // /v1beta 是与 /v1 不同的段（Gemini 原生面），/v1 前缀判定不覆盖它。
      return (
        under("/v1") || under("/v1beta") || under("/admin") || under("/version") || under("/health")
      );
    };
    // guard：API 路径跳过静态层，交给已注册的 admin/version 路由或 gateway 兜底。
    const notApi = (handler: MiddlewareHandler): MiddlewareHandler => (c, next) =>
      isApiPath(c.req.path) ? next() : handler(c, next);
    // 存在的资产文件（serveStatic 未命中时 next() 落到 SPA 回退）。
    app.get("*", notApi(serveStatic({ root: assetsRoot })));
    // SPA 回退：前端路由深链/刷新不 404。
    app.get("*", notApi(serveStatic({ root: assetsRoot, path: "index.html" })));
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
  // 内置 Web 管理端缺省资产目录：镜像内 admin-ui dist（构建烤入）；不存在 = 关闭
  //（本地纯 API 开发形态），不打扰现有工作流。
  const defaultAssetsDir = resolve(import.meta.dir, "../../admin-ui/dist");
  const assetsDir = existsSync(defaultAssetsDir) ? defaultAssetsDir : null;
  const app = createApp({ env, assetsDir });
  // 自签名证书 HTTPS（tailnet 不支持 tailscale cert 的部署形态）：给出证书对时启用
  // TLS；Bun 原生接受，WKWebView/浏览器经本机信任 CA 后直接可用，满足 macOS ATS。
  const tls =
    env.tlsCertPath !== null && env.tlsKeyPath !== null
      ? { cert: readFileSync(env.tlsCertPath, "utf8"), key: readFileSync(env.tlsKeyPath, "utf8") }
      : undefined;
  Bun.serve({ port: env.port, fetch: app.fetch, tls });
  console.log(
    `lutragate server listening on :${env.port}${tls !== undefined ? " (tls)" : ""} (db: ${env.dbPath})` +
      `${assetsDir !== null ? " (web ui: on)" : " (web ui: off — build admin-ui to enable)"}`,
  );
}
