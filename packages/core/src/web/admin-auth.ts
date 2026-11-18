import type { UserRole } from "@lutragate/shared";
import { timingSafeEqual } from "./auth";
import { jsonError } from "./http";
import { sha256Hex } from "./tokens";

/**
 * Admin-plane auth and CORS (spec §3.5, PRD F5.1-F5.4), runtime-agnostic.
 * The admin credential system is fully separate from the gateway Bearer
 * token: /v1/* credentials never grant /admin/* access.
 */

/** Minimal synchronous-looking database port implemented per adapter. */
export interface AdminDb {
  all<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>;
  run(sql: string, params: unknown[]): Promise<{ changes: number }>;
}

/** Allowed browser origins: local web app and the Tauri shell (spec §3.5). */
const ALLOWED_ORIGIN = /^(http:\/\/localhost(:\d+)?|tauri:\/\/localhost)$/;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, x-admin-token, cf-access-client-id, cf-access-client-secret",
  "access-control-max-age": "86400",
};

export function corsHeaders(origin: string): Record<string, string> {
  return { ...CORS_HEADERS, "access-control-allow-origin": origin };
}

export function isAllowedOrigin(origin: string | null): boolean {
  return origin !== null && ALLOWED_ORIGIN.test(origin);
}

/**
 * Returns a 403 Response when a browser origin is present and not
 * allow-listed; null otherwise. OPTIONS requests are answered here with a
 * preflight (204) or 403.
 */
export function adminCorsGuard(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null; // non-browser clients (curl, server-side)

  if (!isAllowedOrigin(origin)) {
    return jsonError(403, "FORBIDDEN", `origin ${origin} is not allowed`);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  return null;
}

/** Admin credentials resolved by the adapter from its environment. */
export interface AdminCredentials {
  /** X-Admin-Token fallback (server form and Worker without Access). */
  adminToken?: string;
  /** Cloudflare Access service-token pair; takes priority when both set. */
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  /**
   * Optional IP allowlist (spec §3.5 server form). When non-empty, requests
   * must originate from one of these client IPs.
   */
  allowedIps?: readonly string[];
  /** Client IP as determined by the adapter; null when unknown. */
  clientIp?: string | null;
}

/**
 * 身份鉴权结果（多用户 ticket 02）：要么是错误响应，要么是解析出的身份。
 * 虚拟 administrator（引导 ADMIN_TOKEN / CF Access 服务凭证）userId 为空，
 * 审计 actor_user_id 亦为空。
 */
export interface AdminIdentity {
  userId: string | null;
  name: string | null;
  role: UserRole;
}

export type AdminAuthResult = { response: Response } | { identity: AdminIdentity };

const VIRTUAL_ADMIN: AdminIdentity = { userId: null, name: null, role: "administrator" };

/**
 * 管理面身份解析（spec §3.5 多用户版，解析顺序）：
 * 1. IP allowlist（不变）；
 * 2. Cloudflare Access 服务凭证（不变，独占模式，映射为虚拟 administrator）；
 * 3. X-Admin-Token 携带的 lgm_ 管理 token：SHA-256 查 management_token JOIN
 *    user（token 启用、所属用户启用、未过期——expires_at 实时查库判定，无
 *    快照延迟）→ 身份，并内联更新 last_used_at（每次命中都写，无采样无节
 *    流——管理面低 QPS，写放大是伪问题）；lgk_ 哈希集合与 management_token
 *    不相交，天然 401（两平面互斥）；
 * 4. 引导：仅当不存在任何启用的 administrator 且 ADMIN_TOKEN 恒时比较匹配时，
 *    放行为虚拟 administrator；存在启用管理员后 ADMIN_TOKEN 一律 401。
 */
export async function adminAuth(
  request: Request,
  creds: AdminCredentials,
  db: AdminDb,
  now: () => number = Date.now,
): Promise<AdminAuthResult> {
  if (creds.allowedIps !== undefined && creds.allowedIps.length > 0) {
    if (!creds.clientIp || !creds.allowedIps.includes(creds.clientIp)) {
      return { response: jsonError(403, "FORBIDDEN", "client IP is not allowed") };
    }
  }

  if (creds.cfAccessClientId && creds.cfAccessClientSecret) {
    const id = request.headers.get("cf-access-client-id");
    const secret = request.headers.get("cf-access-client-secret");
    const ok =
      id !== null &&
      secret !== null &&
      (await timingSafeEqual(id, creds.cfAccessClientId)) &&
      (await timingSafeEqual(secret, creds.cfAccessClientSecret));
    if (!ok) {
      return { response: jsonError(401, "UNAUTHORIZED", "invalid Cloudflare Access credentials") };
    }
    return { identity: VIRTUAL_ADMIN };
  }

  const presented = request.headers.get("x-admin-token");
  if (presented !== null && presented.length > 0) {
    const nowMs = now();
    const rows = await db.all<{ token_id: string; id: string; name: string; role: UserRole }>(
      "SELECT t.id AS token_id, u.id, u.name, u.role FROM management_token t JOIN user u ON u.id = t.user_id "
        + "WHERE t.token_hash = ? AND t.enabled = 1 AND u.enabled = 1 "
        + "AND (t.expires_at = 0 OR t.expires_at > ?)",
      [await sha256Hex(presented), nowMs],
    );
    if (rows.length > 0) {
      // last_used_at 内联更新（access-control 02）：虚拟管理员无 token 行，天然不写。
      await db.run("UPDATE management_token SET last_used_at = ? WHERE id = ?", [nowMs, rows[0]!.token_id]);
      return { identity: { userId: rows[0]!.id, name: rows[0]!.name, role: rows[0]!.role } };
    }
    if (creds.adminToken && (await timingSafeEqual(presented, creds.adminToken))) {
      const admins = await db.all("SELECT id FROM user WHERE role = 'administrator' AND enabled = 1", []);
      if (admins.length === 0) return { identity: VIRTUAL_ADMIN };
      return {
        response: jsonError(
          401, "UNAUTHORIZED",
          "ADMIN_TOKEN is bootstrap-only and an enabled administrator already exists",
        ),
      };
    }
    return { response: jsonError(401, "UNAUTHORIZED", "missing or invalid admin token") };
  }

  if (!creds.adminToken) {
    return {
      response: jsonError(500, "INTERNAL", "admin auth is not configured (ADMIN_TOKEN or Cloudflare Access)"),
    };
  }
  return { response: jsonError(401, "UNAUTHORIZED", "missing or invalid admin token") };
}
