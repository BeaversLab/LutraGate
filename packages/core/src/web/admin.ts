import { z } from "zod";
import { CUSTOM_PROVIDER_TYPE, PRESET_PROVIDER_IDS, PROTOCOLS, ProviderEndpointsSchema, USER_ROLES, findPresetProvider, type Protocol } from "@lutragate/shared";
import { isValidCidr, parseIpAllowlist } from "../cidr";
import { runKeyTest, type KeyTestResult } from "./key-test";
import { fetchUpstreamModels } from "./model-list";
import {
  ManagementCredentialsSchema,
  fetchVolcengineUsage,
  fetchZhipuUsage,
  type ManagementCredentials,
  type UsageResult,
} from "./provider-usage";
import type { Fetcher } from "../ports";
import { reachableModels } from "./access";
import { SqlConfigStore } from "./config-store";
import { decryptApiKey, encryptApiKey, importEncryptionKey } from "./crypto";
import { jsonError } from "./http";
import { newId } from "./id";
import { generateAccessKey, generateManagementToken, sha256Hex, tokenHint } from "./tokens";
import { adminAuth, adminCorsGuard, corsHeaders, type AdminCredentials, type AdminDb, type AdminIdentity } from "./admin-auth";

export type { AdminDb };

/**
 * /admin/* configuration API (ticket 07, PRD §8), runtime-agnostic: CRUD for
 * providers, keys and mappings, audit trail, log pagination and a versioned
 * backup export, on top of the AdminDb port so the Worker (D1) and Server
 * (bun:sqlite) adapters share one implementation. Keys are encrypted
 * server-side on write; responses never contain plaintext key material——日常
 * 视图只回 key_hint，唯一例外是 /admin/export 的灾备密文快照（desktop 06，
 * 仅 administrator）。Every write should invalidate the adapter's config cache
 * (PRD F2.5) and appends an admin_audit row (PRD F5.5).
 */

export interface AdminDeps {
  db: AdminDb;
  credentials: AdminCredentials;
  /** base64 AES key used to encrypt provider keys on write. */
  encryptionKey?: string;
  /** Override the upstream fetcher for key tests; defaults to native fetch. */
  testFetcher?: Fetcher;
  /** Invalidate the proxy-path config cache after writes. */
  invalidate?(): void;
  /** Injectable clock for tests. */
  now?(): number;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 限额输入（quota）：非负整数，0 = 不限；负数/非整数 → 400。 */
const quotaInput = z.number().int().nonnegative();

// ---- input validation ------------------------------------------------------

const providerTypeBase = z
  .string()
  .refine((t) => (PRESET_PROVIDER_IDS as readonly string[]).includes(t), "unknown provider type");
const providerType = providerTypeBase.default(CUSTOM_PROVIDER_TYPE);

// ManagementCredentialsSchema / ManagementCredentials 定义在 provider-usage
// （避免循环依赖），此处引入并原样对外再导出（schema 属管理 API 面孔）。
export { ManagementCredentialsSchema } from "./provider-usage";
export type { ManagementCredentials } from "./provider-usage";

const ProviderInput = z.object({
  name: z.string().min(1),
  type: providerType,
  endpoints: ProviderEndpointsSchema,
  weight: z.number().int().positive().default(1),
  enabled: z.boolean().default(true),
  /** 冷却覆盖（access-control）：0 = 全局默认（3 次/60s）。 */
  cooldown_failure_threshold: quotaInput.default(0),
  cooldown_ms: quotaInput.default(0),
});
// 显式 optional（不带 default）：zod 的 .partial() 会保留字段默认值，导致
// PUT 缺省字段被默认值覆盖——与 merged 的「缺省保留原值」意图相悖。
const ProviderUpdate = z.object({
  name: z.string().min(1).optional(),
  type: providerTypeBase.optional(),
  endpoints: ProviderEndpointsSchema.optional(),
  weight: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  cooldown_failure_threshold: quotaInput.optional(),
  cooldown_ms: quotaInput.optional(),
});

const KeyInput = z.object({
  provider_id: z.string().regex(ID_PATTERN),
  api_key: z.string().min(4),
  enabled: z.boolean().default(true),
  daily_token_limit: quotaInput.default(0),
  daily_request_limit: quotaInput.default(0),
  /** 管控面凭证（provider-usage 04，key 级）：明文入密文存；缺省 = 不启用。 */
  management_credentials: ManagementCredentialsSchema.nullable().optional(),
});
// 显式 optional 三态：absent = 保留原值；null = 清除；对象 = 替换重加密。
const KeyUpdate = z.object({
  enabled: z.boolean().optional(),
  daily_token_limit: quotaInput.optional(),
  daily_request_limit: quotaInput.optional(),
  management_credentials: ManagementCredentialsSchema.nullable().optional(),
  // 异常恢复（管理端「恢复冷却」按钮）：true = 清零冷却截止与失败计数。
  reset_cooldown: z.boolean().optional(),
});

const MappingInput = z.object({
  client_model: z.string().min(1),
  provider_id: z.string().regex(ID_PATTERN),
  upstream_model: z.string().min(1),
  enabled: z.boolean().default(true),
});
const MappingUpdate = MappingInput.partial();

const UserInput = z.object({
  name: z.string().min(1),
  role: z.enum(USER_ROLES),
});
const UserUpdate = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(USER_ROLES).optional(),
  enabled: z.boolean().optional(),
});

/** IP 白名单条目（access-control）：双栈 CIDR 字符串，非法 → 400。 */
const cidrEntry = z.string().refine(isValidCidr, "invalid CIDR (expect e.g. 10.0.0.0/8 or 2001:db8::/32)");

const AccessKeyInput = z.object({
  name: z.string().min(1),
  daily_token_limit: quotaInput.default(0),
  daily_request_limit: quotaInput.default(0),
  max_concurrency: quotaInput.default(0),
  /** 过期与来源网络（access-control）：0 = 永不过期；空列表 = 不限。 */
  expires_at: quotaInput.default(0),
  ip_allowlist: z.array(cidrEntry).default([]),
});
const AccessKeyUpdate = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  daily_token_limit: quotaInput.optional(),
  daily_request_limit: quotaInput.optional(),
  max_concurrency: quotaInput.optional(),
  expires_at: quotaInput.optional(),
  ip_allowlist: z.array(cidrEntry).optional(),
});

/** lgm_ 重置输入（access-control）：body 可省略（兼容旧调用）。 */
const TokenResetInput = z.object({ expires_at: quotaInput.default(0) });
/** lgm_ 续期输入（access-control）：只改过期、不轮换明文。 */
const TokenExpiryInput = z.object({ expires_at: quotaInput });
/** 授权条目：纯字符串 = 不限额（向后兼容）；对象可带两个预算数字。 */
const GrantEntryInput = z.union([
  z.string().regex(ID_PATTERN),
  z.object({
    provider_key_id: z.string().regex(ID_PATTERN),
    daily_token_limit: quotaInput.default(0),
    daily_request_limit: quotaInput.default(0),
  }),
]);
const GrantsInput = z.object({ provider_key_ids: z.array(GrantEntryInput) });

interface KeyRow {
  id: string;
  provider_id: string;
  key_hint: string;
  enabled: number;
  cooldown_until: number;
  failure_count: number;
  daily_token_limit: number;
  daily_request_limit: number;
  created_at: number;
  updated_at: number;
  /** 最近一次经此 Key 的请求时间（request_log MAX(ts)）；无日志为 null。 */
  last_used_at: number | null;
}

// last_used_at：request_log 按 key 的最近请求时间（子查询走 idx_log_key，
// 0011）。无日志行为 NULL，管理端列表显示「最后使用」。
const KEY_COLUMNS = "id, provider_id, key_hint, enabled, cooldown_until, failure_count, daily_token_limit, daily_request_limit, created_at, updated_at, (SELECT MAX(ts) FROM request_log WHERE key_id = provider_key.id) AS last_used_at";

/** Redacted key view — the only key representation ever returned. */
function redactKey(row: KeyRow) {
  return {
    id: row.id,
    provider_id: row.provider_id,
    key_hint: row.key_hint,
    enabled: row.enabled,
    cooldown_until: row.cooldown_until,
    failure_count: row.failure_count,
    daily_token_limit: row.daily_token_limit,
    daily_request_limit: row.daily_request_limit,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_used_at: row.last_used_at ?? null,
  };
}

/** Thrown when the request body is not valid JSON. */
class BadJsonError extends Error {}

export async function handleAdmin(request: Request, deps: AdminDeps): Promise<Response> {
  const cors = adminCorsGuard(request);
  if (cors) return cors;

  const auth = await adminAuth(request, deps.credentials, deps.db, deps.now ?? Date.now);
  if ("response" in auth) return auth.response;
  const identity = auth.identity;

  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {};
  if (origin !== null && request.method !== "OPTIONS") {
    Object.assign(headers, corsHeaders(origin));
  }

  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean); // ["admin", resource, id?, action?]
  const resource = segments[1];
  const id = segments[2];
  const now = () => (deps.now ?? Date.now)();

  try {
    const resp = await route(request, deps, { resource, id, action: segments[3], now, identity });
    if (resp === null) return jsonError(404, "NOT_FOUND", `no admin route for ${url.pathname}`);
    for (const [name, value] of Object.entries(headers)) {
      resp.headers.set(name, value);
    }
    return resp;
  } catch (err) {
    if (err instanceof BadJsonError) {
      return jsonError(400, "BAD_REQUEST", "request body must be valid JSON");
    }
    if (err instanceof z.ZodError) {
      return jsonError(400, "BAD_REQUEST", err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE")) {
      return jsonError(409, "CONFLICT", "mapping for this client_model and provider already exists");
    }
    return jsonError(500, "INTERNAL", "admin operation failed");
  }
}

async function route(request: Request, deps: AdminDeps, ctx: {
  resource: string | undefined;
  id: string | undefined;
  action: string | undefined;
  now: () => number;
  identity: AdminIdentity;
}): Promise<Response | null> {
  const { resource, id, action, now, identity } = ctx;
  const db = deps.db;
  // 审计 actor：虚拟管理员（引导/CF Access）为空，其余为操作用户 id。
  const actor = identity.userId;

  const needId = (): string | null =>
    id && ID_PATTERN.test(id) ? id : null;

  // 角色门（tickets 02/05）：user 角色仅可访问自己的资源——me、access-keys
  // 与 usage（永远只聚合自己的数据，SQL 层强制）；logs（desktop 04 起允许
  // user 角色读取，handler 内 SQL 钉定 user_id = 自己，仅 GET）。dash-status 01
  // 起 keys 的 usage 子动作（GET）对 user 角色有条件放行——grants 归属校验在
  // case "keys" 内，这里只开门。
  const USER_RESOURCES = new Set(["me", "access-keys", "usage", "logs"]);
  const keyUsageSubaction =
    resource === "keys" && action === "usage" && request.method === "GET";
  if (identity.role !== "administrator" && !USER_RESOURCES.has(resource ?? "") && !keyUsageSubaction) {
    return jsonError(403, "FORBIDDEN", `role "${identity.role}" cannot access /admin/${resource ?? ""}`);
  }

  switch (resource) {
    case "me": {
      // GET /admin/me/grants：被分配的上游 key + 按授权可达的模型（可达性算法
      // 与 /v1/models 一致，multi-user ticket 04）。
      if (id === "grants") {
        if (request.method !== "GET") return null;
        if (identity.userId === null) {
          return jsonError(400, "BAD_REQUEST", "virtual administrator has no user_id");
        }
        return json({
          user_id: identity.userId,
          grants: await userGrantViews(db, identity.userId),
          models: reachableModels(
            await new SqlConfigStore(db).getActiveConfig(),
            identity.userId,
          ),
        });
      }
      if (request.method === "GET") {
        return json({ id: identity.userId, name: identity.name, role: identity.role });
      }
      return null;
    }
    case "providers": {
      const providerId = needId();
      // 子路径动作（GET /admin/providers/:id/models、POST /admin/providers/:id/test）：
      // 上游模型发现（model-discovery 01）与连通性测试服务端转发（03）。必须先于
      // 集合级 GET 判定，否则被 listProviders 吞掉。
      if (providerId && action === "models" && request.method === "GET") {
        return listProviderModels(deps, providerId);
      }
      if (providerId && action === "test" && request.method === "POST") {
        return testProviderById(request, deps, providerId);
      }
      if (request.method === "GET" && !providerId) return listProviders(db);
      if (request.method === "POST") return createProvider(request, db, deps, now, actor);
      if (request.method === "PUT" && providerId) return updateProvider(request, db, deps, now, providerId, actor);
      if (request.method === "DELETE" && providerId) return deleteRow(db, deps, now, actor, "provider", providerId, "provider.delete");
      return null;
    }
    case "keys": {
      const keyId = needId();
      // 子路径动作（GET /admin/keys/:id/usage、POST /admin/keys/:id/test）必须
      // 先于集合级判定，否则被 listKeys 吞掉。
      if (keyId && action === "usage" && request.method === "GET") {
        // dash-status 01：user 角色范围钉定——只放行自己 grants 内的上游 key
        //（同 usage/logs 范式：服务端显式校验，不做响应后过滤）。
        if (identity.role !== "administrator") {
          if (identity.userId === null) {
            return jsonError(403, "FORBIDDEN", "usage requires a user identity");
          }
          const granted = await db.all(
            "SELECT 1 FROM user_key_grant WHERE user_id = ? AND provider_key_id = ? LIMIT 1",
            [identity.userId, keyId],
          );
          if (granted.length === 0) {
            return jsonError(403, "FORBIDDEN", "this provider key is not granted to you");
          }
        }
        // refresh=1：手动刷新绕过 TTL（用户故事「立即重新拉取」）。
        const refresh = new URL(request.url).searchParams.get("refresh") === "1";
        return getKeyUsage(deps, keyId, refresh);
      }
      if (keyId && action === "test" && request.method === "POST") {
        return testKeyById(request, deps, keyId);
      }
      if (request.method === "GET" && !keyId) return listKeys(db);
      if (request.method === "POST" && !keyId) return createKey(request, deps, now, actor);
      if (request.method === "PUT" && keyId) return updateKey(request, db, deps, now, keyId, actor);
      if (request.method === "DELETE" && keyId) return deleteRow(db, deps, now, actor, "provider_key", keyId, "key.delete");
      return null;
    }
    case "mappings": {
      if (request.method === "GET") return listMappings(db);
      if (request.method === "POST") return createMapping(request, db, deps, now, actor);
      const mappingId = needId();
      if (request.method === "PUT" && mappingId) return updateMapping(request, db, deps, now, mappingId, actor);
      if (request.method === "DELETE" && mappingId) return deleteRow(db, deps, now, actor, "model_mapping", mappingId, "mapping.delete");
      return null;
    }
    case "users": {
      if (request.method === "GET" && !id) return listUsers(db);
      if (request.method === "POST" && !id) return createUser(request, db, deps, now, actor);
      const userId = needId();
      // 子路径动作（POST /users/:id/token、PUT /users/:id/token、
      // GET|PUT /users/:id/grants、POST /users/:id/access-keys）。
      if (userId && action === "token" && request.method === "POST") {
        return resetUserToken(request, db, deps, now, actor, userId);
      }
      if (userId && action === "token" && request.method === "PUT") {
        return updateUserTokenExpiry(request, db, deps, now, actor, userId);
      }
      if (userId && action === "grants") {
        if (request.method === "GET") return listUserGrants(db, userId);
        if (request.method === "PUT") return replaceUserGrants(request, db, deps, now, actor, userId);
      }
      if (userId && action === "access-keys" && request.method === "POST") {
        return createAccessKey(request, db, deps, now, actor, userId);
      }
      if (request.method === "PUT" && userId) return updateUser(request, db, deps, now, userId, actor);
      if (request.method === "DELETE" && userId) return deleteUser(db, deps, now, actor, userId);
      return null;
    }
    case "access-keys": {
      if (request.method === "GET" && !id) return listAccessKeys(db, identity);
      if (request.method === "POST" && !id) {
        // 虚拟管理员无 user_id，须用 /users/:id/access-keys 代建。
        if (identity.userId === null) {
          return jsonError(400, "BAD_REQUEST", "virtual administrator has no user_id; use POST /admin/users/:id/access-keys");
        }
        return createAccessKey(request, db, deps, now, actor, identity.userId);
      }
      const keyId = needId();
      if (request.method === "PUT" && keyId) return updateAccessKey(request, db, deps, now, actor, identity, keyId);
      if (request.method === "DELETE" && keyId) return deleteAccessKey(db, deps, now, actor, identity, keyId);
      return null;
    }
    case "logs":
      if (request.method === "GET") return listLogs(db, new URL(request.url), identity);
      return null;
    case "usage":
      if (request.method === "GET") return usageAggregate(db, new URL(request.url), identity);
      return null;
    case "audit":
      if (request.method === "GET") return listAudit(db);
      return null;
    case "export":
      if (request.method === "GET") return exportConfig(db, now);
      return null;
    default:
      return null;
  }
}

// ---- shared helpers ----------------------------------------------------------

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadJsonError();
  }
}

/** 读可选 body：空 body / 无 content-type 视为 {}（兼容无 body 的旧调用）。 */
async function readJsonOptional(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadJsonError();
  }
}

async function writeAudit(
  db: AdminDb,
  now: () => number,
  actor: string | null,
  action: string,
  target: string,
  detail: unknown,
  deps: AdminDeps,
): Promise<void> {
  await db
    .run("INSERT INTO admin_audit (id, ts, action, target, detail, actor_user_id) VALUES (?, ?, ?, ?, ?, ?)", [
      newId(), now(), action, target, detail === undefined ? null : JSON.stringify(detail), actor,
    ]);
  deps.invalidate?.();
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

// ---- providers ----------------------------------------------------------------

/** 聚合 provider 行 + 端点表为对外形状。 */
async function providerViews(db: AdminDb): Promise<Array<Record<string, unknown>>> {
  const rows = await db.all<Record<string, unknown>>("SELECT * FROM provider ORDER BY created_at", []);
  const endpoints = await db.all<{ provider_id: string; protocol: string; base_url: string }>(
    "SELECT provider_id, protocol, base_url FROM provider_endpoint", [],
  );
  const byProvider = new Map<string, Partial<Record<Protocol, string>>>();
  for (const e of endpoints) {
    const map = byProvider.get(e.provider_id) ?? {};
    if ((PROTOCOLS as readonly string[]).includes(e.protocol)) map[e.protocol as Protocol] = e.base_url;
    byProvider.set(e.provider_id, map);
  }
  return rows.map((r) => ({ ...r, base_url: undefined, endpoints: byProvider.get(r.id as string) ?? {} }));
}

/** 整体替换某供应商的端点集（创建/更新共用）。 */
async function replaceEndpoints(db: AdminDb, providerId: string, endpoints: Partial<Record<Protocol, string>>): Promise<void> {
  await db.run("DELETE FROM provider_endpoint WHERE provider_id = ?", [providerId]);
  for (const protocol of PROTOCOLS) {
    const url = endpoints[protocol];
    if (url === undefined) continue;
    await db.run(
      "INSERT INTO provider_endpoint (id, provider_id, protocol, base_url) VALUES (?, ?, ?, ?)",
      [newId(), providerId, protocol, url],
    );
  }
}

async function listProviders(db: AdminDb): Promise<Response> {
  return json(await providerViews(db));
}

async function createProvider(request: Request, db: AdminDb, deps: AdminDeps, now: () => number, actor: string | null): Promise<Response> {
  const input = ProviderInput.parse(await readJson(request));
  const id = newId();
  const ts = now();
  await db.run(
    "INSERT INTO provider (id, name, type, enabled, weight, cooldown_failure_threshold, cooldown_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, input.name, input.type, input.enabled ? 1 : 0, input.weight, input.cooldown_failure_threshold, input.cooldown_ms, ts, ts],
  );
  await replaceEndpoints(db, id, input.endpoints);
  await writeAudit(db, now, actor, "provider.create", id, { name: input.name, endpoints: input.endpoints }, deps);
  return json({ id, ...input, created_at: ts, updated_at: ts }, 201);
}

async function updateProvider(request: Request, db: AdminDb, deps: AdminDeps, now: () => number, id: string, actor: string | null): Promise<Response> {
  const patch = ProviderUpdate.parse(await readJson(request));
  const existing = await db.all<Record<string, unknown>>("SELECT * FROM provider WHERE id = ?", [id]);
  if (existing.length === 0) return jsonError(404, "NOT_FOUND", `provider ${id} not found`);
  const row = existing[0]!;
  const currentEndpoints = await db.all<{ protocol: string; base_url: string }>(
    "SELECT protocol, base_url FROM provider_endpoint WHERE provider_id = ?", [id],
  );
  const current: Partial<Record<Protocol, string>> = {};
  for (const e of currentEndpoints) {
    if ((PROTOCOLS as readonly string[]).includes(e.protocol)) current[e.protocol as Protocol] = e.base_url;
  }
  const merged = {
    name: patch.name ?? row.name,
    type: patch.type ?? (row.type as string | undefined) ?? CUSTOM_PROVIDER_TYPE,
    endpoints: patch.endpoints ?? current,
    enabled: patch.enabled ?? row.enabled !== 0,
    weight: patch.weight ?? row.weight,
    cooldown_failure_threshold: patch.cooldown_failure_threshold ?? (row.cooldown_failure_threshold as number) ?? 0,
    cooldown_ms: patch.cooldown_ms ?? (row.cooldown_ms as number) ?? 0,
  };
  await db.run(
    "UPDATE provider SET name = ?, type = ?, enabled = ?, weight = ?, cooldown_failure_threshold = ?, cooldown_ms = ?, updated_at = ? WHERE id = ?",
    [merged.name, merged.type, merged.enabled ? 1 : 0, merged.weight, merged.cooldown_failure_threshold, merged.cooldown_ms, now(), id],
  );
  if (patch.endpoints !== undefined) {
    await replaceEndpoints(db, id, merged.endpoints);
  }
  await writeAudit(db, now, actor, "provider.update", id, patch, deps);
  return json({ id, ...merged, updated_at: now() });
}

// ---- keys ---------------------------------------------------------------------

async function listKeys(db: AdminDb): Promise<Response> {
  const rows = await db.all<KeyRow>(
    `SELECT ${KEY_COLUMNS} FROM provider_key ORDER BY created_at`,
    [],
  );
  return json(rows.map(redactKey));
}

/** 管控面凭证整体加密（明文 JSON → base64 密文；密文不出服务端、不出响应）。 */
async function encryptManagementCredentials(deps: AdminDeps, creds: ManagementCredentials): Promise<string> {
  const cryptoKey = await importEncryptionKey(deps.encryptionKey!);
  return encryptApiKey(cryptoKey, JSON.stringify(creds));
}

async function createKey(request: Request, deps: AdminDeps, now: () => number, actor: string | null): Promise<Response> {
  const { db, encryptionKey } = deps;
  const input = KeyInput.parse(await readJson(request));
  if (!encryptionKey) {
    return jsonError(500, "INTERNAL", "ENCRYPTION_KEY is not configured");
  }
  const provider = await db.all("SELECT id FROM provider WHERE id = ?", [input.provider_id]);
  if (provider.length === 0) return jsonError(404, "NOT_FOUND", `provider ${input.provider_id} not found`);

  const cryptoKey = await importEncryptionKey(encryptionKey);
  const encrypted = await encryptApiKey(cryptoKey, input.api_key);
  const keyHint = input.api_key.slice(-4);
  const encryptedCredentials = input.management_credentials
    ? await encryptManagementCredentials(deps, input.management_credentials)
    : null;
  const id = newId();
  const ts = now();
  await db.run(
    "INSERT INTO provider_key (id, provider_id, encrypted_key, key_hint, enabled, cooldown_until, failure_count, daily_token_limit, daily_request_limit, management_credentials, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)",
    [id, input.provider_id, encrypted, keyHint, input.enabled ? 1 : 0, input.daily_token_limit, input.daily_request_limit, encryptedCredentials, ts, ts],
  );
  await writeAudit(db, now, actor, "key.create", id, { provider_id: input.provider_id, key_hint: keyHint }, deps);
  // Never echo key material back; hint only.
  return json({
    id, provider_id: input.provider_id, key_hint: keyHint, enabled: input.enabled,
    cooldown_until: 0, failure_count: 0,
    daily_token_limit: input.daily_token_limit, daily_request_limit: input.daily_request_limit,
    created_at: ts, updated_at: ts,
  }, 201);
}

async function updateKey(request: Request, db: AdminDb, deps: AdminDeps, now: () => number, id: string, actor: string | null): Promise<Response> {
  const patch = KeyUpdate.parse(await readJson(request));
  // management_credentials 的三态合并需要读存量密文（KEY_COLUMNS 刻意不含它）。
  const existing = await db.all<KeyRow & { management_credentials?: string | null }>(
    `SELECT ${KEY_COLUMNS}, management_credentials FROM provider_key WHERE id = ?`, [id],
  );
  if (existing.length === 0) return jsonError(404, "NOT_FOUND", `key ${id} not found`);
  const row = existing[0]!;
  // 凭证三态：absent = 保留原值；null = 清除；对象 = 替换重加密。明文不回显不进审计。
  let credentialsValue: string | null;
  if (patch.management_credentials === undefined) {
    credentialsValue = row.management_credentials ?? null;
  } else if (patch.management_credentials === null) {
    credentialsValue = null;
  } else {
    if (!deps.encryptionKey) {
      return jsonError(500, "INTERNAL", "ENCRYPTION_KEY is not configured");
    }
    credentialsValue = await encryptManagementCredentials(deps, patch.management_credentials);
  }
  const merged = {
    enabled: patch.enabled ?? row.enabled !== 0,
    daily_token_limit: patch.daily_token_limit ?? row.daily_token_limit,
    daily_request_limit: patch.daily_request_limit ?? row.daily_request_limit,
  };
  // reset_cooldown：管理端异常恢复——清零冷却截止与失败计数（正常路径两者原值保留）。
  const clearCooldown = patch.reset_cooldown === true;
  await db.run(
    "UPDATE provider_key SET enabled = ?, daily_token_limit = ?, daily_request_limit = ?, management_credentials = ?, updated_at = ?, cooldown_until = ?, failure_count = ? WHERE id = ?",
    [merged.enabled ? 1 : 0, merged.daily_token_limit, merged.daily_request_limit, credentialsValue, now(), clearCooldown ? 0 : row.cooldown_until, clearCooldown ? 0 : row.failure_count, id],
  );
  const { management_credentials: _auditCredentials, ...auditPatch } = patch;
  await writeAudit(db, now, actor, "key.update", id, auditPatch, deps);
  return json({ id, ...merged, updated_at: now(), last_used_at: row.last_used_at ?? null });
}

// ---- mappings -------------------------------------------------------------------

async function listMappings(db: AdminDb): Promise<Response> {
  return json(await db.all("SELECT * FROM model_mapping ORDER BY client_model", []));
}

async function createMapping(request: Request, db: AdminDb, deps: AdminDeps, now: () => number, actor: string | null): Promise<Response> {
  const input = MappingInput.parse(await readJson(request));
  const provider = await db.all("SELECT id FROM provider WHERE id = ?", [input.provider_id]);
  if (provider.length === 0) return jsonError(404, "NOT_FOUND", `provider ${input.provider_id} not found`);
  const id = newId();
  await db.run(
    "INSERT INTO model_mapping (id, client_model, provider_id, upstream_model, enabled) VALUES (?, ?, ?, ?, ?)",
    [id, input.client_model, input.provider_id, input.upstream_model, input.enabled ? 1 : 0],
  );
  await writeAudit(db, now, actor, "mapping.create", id, input, deps);
  return json({ id, ...input }, 201);
}

async function updateMapping(request: Request, db: AdminDb, deps: AdminDeps, now: () => number, id: string, actor: string | null): Promise<Response> {
  const patch = MappingUpdate.parse(await readJson(request));
  const existing = await db.all<Record<string, unknown>>("SELECT * FROM model_mapping WHERE id = ?", [id]);
  if (existing.length === 0) return jsonError(404, "NOT_FOUND", `mapping ${id} not found`);
  const mergedProviderId = patch.provider_id ?? (existing[0]!.provider_id as string);
  const provider = await db.all("SELECT id FROM provider WHERE id = ?", [mergedProviderId]);
  if (provider.length === 0) return jsonError(404, "NOT_FOUND", `provider ${mergedProviderId} not found`);
  const merged = {
    client_model: patch.client_model ?? existing[0]!.client_model,
    provider_id: mergedProviderId,
    upstream_model: patch.upstream_model ?? existing[0]!.upstream_model,
    enabled: patch.enabled ?? existing[0]!.enabled !== 0,
  };
  await db.run(
    "UPDATE model_mapping SET client_model = ?, provider_id = ?, upstream_model = ?, enabled = ? WHERE id = ?",
    [merged.client_model, merged.provider_id, merged.upstream_model, merged.enabled ? 1 : 0, id],
  );
  await writeAudit(db, now, actor, "mapping.update", id, patch, deps);
  return json({ id, ...merged });
}

// ---- users ---------------------------------------------------------------------

interface UserRow {
  id: string;
  name: string;
  role: string;
  enabled: number;
  created_at: number;
  updated_at: number;
  /** 随行管理 token 视图（access-control）：无 token 行时缺省 0/空。 */
  token_expires_at?: number;
  token_last_used_at?: number;
  token_hint?: string;
}

// 用户行 + 其管理 token 的尾号/过期/最近使用（LEFT JOIN：虚拟/极端场景可无 token 行）。
const USER_TOKEN_COLUMNS = "u.id, u.name, u.role, u.enabled, u.created_at, u.updated_at, "
  + "COALESCE(t.expires_at, 0) AS token_expires_at, COALESCE(t.last_used_at, 0) AS token_last_used_at, "
  + "COALESCE(t.key_hint, '') AS token_hint";

function userView(row: UserRow) {
  return {
    id: row.id, name: row.name, role: row.role, enabled: row.enabled !== 0,
    created_at: row.created_at, updated_at: row.updated_at,
    token_expires_at: row.token_expires_at ?? 0, token_last_used_at: row.token_last_used_at ?? 0,
    token_hint: row.token_hint ?? "",
  };
}

async function listUsers(db: AdminDb): Promise<Response> {
  const rows = await db.all<UserRow>(
    `SELECT ${USER_TOKEN_COLUMNS} FROM user u LEFT JOIN management_token t ON t.user_id = u.id ORDER BY u.created_at`, [],
  );
  return json(rows.map(userView));
}

async function findUser(db: AdminDb, id: string): Promise<UserRow | null> {
  const rows = await db.all<UserRow>(
    `SELECT ${USER_TOKEN_COLUMNS} FROM user u LEFT JOIN management_token t ON t.user_id = u.id WHERE u.id = ?`, [id],
  );
  return rows[0] ?? null;
}

/** 为用户新发一把管理 token（删旧插新），返回一次性明文；expiresAt 0 = 永不过期。 */
async function issueManagementToken(
  db: AdminDb, now: () => number, userId: string, expiresAt = 0,
): Promise<{ token: string; token_hint: string }> {
  const token = generateManagementToken();
  const ts = now();
  await db.run("DELETE FROM management_token WHERE user_id = ?", [userId]);
  await db.run(
    "INSERT INTO management_token (id, user_id, token_hash, key_hint, enabled, expires_at, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?)",
    [newId(), userId, await sha256Hex(token), tokenHint(token), expiresAt, ts, ts],
  );
  return { token, token_hint: tokenHint(token) };
}

async function createUser(request: Request, db: AdminDb, deps: AdminDeps, now: () => number, actor: string | null): Promise<Response> {
  const input = UserInput.parse(await readJson(request));
  const clash = await db.all("SELECT id FROM user WHERE name = ?", [input.name]);
  if (clash.length > 0) return jsonError(409, "CONFLICT", `user name "${input.name}" already exists`);
  const id = newId();
  const ts = now();
  await db.run(
    "INSERT INTO user (id, name, role, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    [id, input.name, input.role, ts, ts],
  );
  const issued = await issueManagementToken(db, now, id);
  await writeAudit(db, now, actor, "user.create", id, { name: input.name, role: input.role, token_hint: issued.token_hint }, deps);
  // management_token 明文只在创建响应中出现一次。
  return json(
    { ...userView({ id, name: input.name, role: input.role, enabled: 1, created_at: ts, updated_at: ts, token_hint: issued.token_hint }), management_token: issued.token, token_hint: issued.token_hint },
    201,
  );
}

async function updateUser(request: Request, db: AdminDb, deps: AdminDeps, now: () => number, id: string, actor: string | null): Promise<Response> {
  const patch = UserUpdate.parse(await readJson(request));
  const row = await findUser(db, id);
  if (row === null) return jsonError(404, "NOT_FOUND", `user ${id} not found`);
  const merged = {
    name: patch.name ?? row.name,
    role: patch.role ?? row.role,
    enabled: patch.enabled ?? row.enabled !== 0,
  };
  if (merged.name !== row.name) {
    const clash = await db.all("SELECT id FROM user WHERE name = ? AND id != ?", [merged.name, id]);
    if (clash.length > 0) return jsonError(409, "CONFLICT", `user name "${merged.name}" already exists`);
  }
  if (row.role === "administrator" && row.enabled !== 0 && (merged.role !== "administrator" || !merged.enabled)) {
    const guard = await lastAdminGuard(db, id);
    if (guard) return guard;
  }
  const ts = now();
  await db.run(
    "UPDATE user SET name = ?, role = ?, enabled = ?, updated_at = ? WHERE id = ?",
    [merged.name, merged.role, merged.enabled ? 1 : 0, ts, id],
  );
  await writeAudit(db, now, actor, "user.update", id, patch, deps);
  return json({ ...userView({ ...row, ...merged, enabled: merged.enabled ? 1 : 0, updated_at: ts }) });
}

async function resetUserToken(request: Request, db: AdminDb, deps: AdminDeps, now: () => number, actor: string | null, id: string): Promise<Response> {
  const row = await findUser(db, id);
  if (row === null) return jsonError(404, "NOT_FOUND", `user ${id} not found`);
  const input = TokenResetInput.parse(await readJsonOptional(request));
  const issued = await issueManagementToken(db, now, id, input.expires_at);
  await writeAudit(db, now, actor, "user.token.reset", id, { token_hint: issued.token_hint, expires_at: input.expires_at }, deps);
  return json({ user_id: id, management_token: issued.token, token_hint: issued.token_hint, expires_at: input.expires_at });
}

/** PUT /admin/users/:id/token（access-control）：只改过期、不轮换明文（续期 ≠ 轮换）。 */
async function updateUserTokenExpiry(request: Request, db: AdminDb, deps: AdminDeps, now: () => number, actor: string | null, id: string): Promise<Response> {
  const input = TokenExpiryInput.parse(await readJson(request));
  const row = await findUser(db, id);
  if (row === null) return jsonError(404, "NOT_FOUND", `user ${id} not found`);
  const ts = now();
  const res = await db.run(
    "UPDATE management_token SET expires_at = ?, updated_at = ? WHERE user_id = ?",
    [input.expires_at, ts, id],
  );
  if (!res.changes) return jsonError(404, "NOT_FOUND", `user ${id} has no management token`);
  await writeAudit(db, now, actor, "user.token.update", id, { expires_at: input.expires_at }, deps);
  return json({ user_id: id, expires_at: input.expires_at, updated_at: ts });
}

/** 最后一个启用 administrator 不可被禁用/降级/删除（否则锁死管理面）。 */
async function lastAdminGuard(db: AdminDb, id: string): Promise<Response | null> {
  const others = await db.all(
    "SELECT id FROM user WHERE role = 'administrator' AND enabled = 1 AND id != ?", [id],
  );
  if (others.length === 0) {
    return jsonError(409, "CONFLICT", "cannot disable, demote or delete the last enabled administrator");
  }
  return null;
}

async function deleteUser(db: AdminDb, deps: AdminDeps, now: () => number, actor: string | null, id: string): Promise<Response> {
  const row = await findUser(db, id);
  if (row === null) return jsonError(404, "NOT_FOUND", `user ${id} not found`);
  if (row.role === "administrator" && row.enabled !== 0) {
    const guard = await lastAdminGuard(db, id);
    if (guard) return guard;
  }
  // 级联清理其管理 token、访问 key 与授权（FK ON DELETE CASCADE）。
  await db.run("DELETE FROM user WHERE id = ?", [id]);
  await writeAudit(db, now, actor, "user.delete", id, undefined, deps);
  return json({ deleted: true, id });
}

// ---- access keys & grants（multi-user 03）---------------------------------------

interface AccessKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hint: string;
  enabled: number;
  daily_token_limit: number;
  daily_request_limit: number;
  max_concurrency: number;
  expires_at: number;
  ip_allowlist: string;
  created_at: number;
  updated_at: number;
}

/** 访问 key 对外形状——绝不包含 key_hash 或明文。 */
function accessKeyView(row: AccessKeyRow) {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    key_hint: row.key_hint,
    enabled: row.enabled !== 0,
    daily_token_limit: row.daily_token_limit,
    daily_request_limit: row.daily_request_limit,
    max_concurrency: row.max_concurrency,
    expires_at: row.expires_at,
    ip_allowlist: parseIpAllowlist(row.ip_allowlist),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const ACCESS_KEY_COLUMNS = "id, user_id, name, key_hint, enabled, daily_token_limit, daily_request_limit, max_concurrency, expires_at, ip_allowlist, created_at, updated_at";

/** user 角色的所有访问 key 操作都把范围钉死在身份 user_id 上（SQL 层强制）。 */
async function listAccessKeys(db: AdminDb, identity: AdminIdentity): Promise<Response> {
  const admin = identity.role === "administrator";
  const rows = await db.all<AccessKeyRow>(
    `SELECT ${ACCESS_KEY_COLUMNS} FROM access_key ${admin ? "" : "WHERE user_id = ?"} ORDER BY created_at`,
    admin ? [] : [identity.userId],
  );
  return json(rows.map(accessKeyView));
}

/** 为用户新发一把访问 key（lgk_），返回一次性明文；库里只存哈希。 */
async function createAccessKey(
  request: Request, db: AdminDb, deps: AdminDeps, now: () => number, actor: string | null, userId: string,
): Promise<Response> {
  const input = AccessKeyInput.parse(await readJson(request));
  if ((await findUser(db, userId)) === null) {
    return jsonError(404, "NOT_FOUND", `user ${userId} not found`);
  }
  const key = generateAccessKey();
  const id = newId();
  const ts = now();
  await db.run(
    "INSERT INTO access_key (id, user_id, name, key_hash, key_hint, enabled, daily_token_limit, daily_request_limit, max_concurrency, expires_at, ip_allowlist, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)",
    [id, userId, input.name, await sha256Hex(key), tokenHint(key), input.daily_token_limit, input.daily_request_limit, input.max_concurrency, input.expires_at, JSON.stringify(input.ip_allowlist), ts, ts],
  );
  await writeAudit(db, now, actor, "access_key.create", id, { user_id: userId, name: input.name, key_hint: tokenHint(key) }, deps);
  // 明文只在创建响应中出现一次。
  return json({
    ...accessKeyView({
      id, user_id: userId, name: input.name, key_hint: tokenHint(key), enabled: 1,
      daily_token_limit: input.daily_token_limit, daily_request_limit: input.daily_request_limit,
      max_concurrency: input.max_concurrency,
      expires_at: input.expires_at, ip_allowlist: JSON.stringify(input.ip_allowlist),
      created_at: ts, updated_at: ts,
    }),
    access_key: key,
  }, 201);
}

async function findAccessKey(db: AdminDb, keyId: string): Promise<AccessKeyRow | null> {
  const rows = await db.all<AccessKeyRow>(
    `SELECT ${ACCESS_KEY_COLUMNS} FROM access_key WHERE id = ?`,
    [keyId],
  );
  return rows[0] ?? null;
}

/** user 角色的写语句带上 `AND user_id = 身份` 谓词——归属在 SQL 层强制，他人的 key 与不存在的 key 同样 404。 */
function ownershipPredicate(identity: AdminIdentity): { clause: string; params: string[] } {
  return identity.role === "administrator"
    ? { clause: "", params: [] }
    : { clause: " AND user_id = ?", params: [identity.userId!] };
}

async function updateAccessKey(
  request: Request, db: AdminDb, deps: AdminDeps, now: () => number, actor: string | null,
  identity: AdminIdentity, keyId: string,
): Promise<Response> {
  const patch = AccessKeyUpdate.parse(await readJson(request));
  const row = await findAccessKey(db, keyId);
  if (row === null) return jsonError(404, "NOT_FOUND", `access key ${keyId} not found`);
  const merged = {
    name: patch.name ?? row.name,
    enabled: patch.enabled ?? row.enabled !== 0,
    daily_token_limit: patch.daily_token_limit ?? row.daily_token_limit,
    daily_request_limit: patch.daily_request_limit ?? row.daily_request_limit,
    max_concurrency: patch.max_concurrency ?? row.max_concurrency,
    expires_at: patch.expires_at ?? row.expires_at,
    // 行内是 JSON 字符串；未提交时原样保留。
    ip_allowlist: JSON.stringify(patch.ip_allowlist ?? parseIpAllowlist(row.ip_allowlist)),
  };
  const ts = now();
  const own = ownershipPredicate(identity);
  const res = await db.run(
    `UPDATE access_key SET name = ?, enabled = ?, daily_token_limit = ?, daily_request_limit = ?, max_concurrency = ?, expires_at = ?, ip_allowlist = ?, updated_at = ? WHERE id = ?${own.clause}`,
    [merged.name, merged.enabled ? 1 : 0, merged.daily_token_limit, merged.daily_request_limit, merged.max_concurrency, merged.expires_at, merged.ip_allowlist, ts, keyId, ...own.params],
  );
  if (!res.changes) return jsonError(404, "NOT_FOUND", `access key ${keyId} not found`);
  await writeAudit(db, now, actor, "access_key.update", keyId, patch, deps);
  return json({ ...accessKeyView({ ...row, ...merged, enabled: merged.enabled ? 1 : 0, updated_at: ts }) });
}

async function deleteAccessKey(
  db: AdminDb, deps: AdminDeps, now: () => number, actor: string | null, identity: AdminIdentity, keyId: string,
): Promise<Response> {
  const own = ownershipPredicate(identity);
  const res = await db.run(
    `DELETE FROM access_key WHERE id = ?${own.clause}`,
    [keyId, ...own.params],
  );
  if (!res.changes) return jsonError(404, "NOT_FOUND", `access key ${keyId} not found`);
  await writeAudit(db, now, actor, "access_key.delete", keyId, undefined, deps);
  return json({ deleted: true, id: keyId });
}

/** 某用户当前被授权的上游 provider_key（含 provider 名、key hint 与授权限额）。 */
async function userGrantViews(db: AdminDb, userId: string): Promise<Array<Record<string, unknown>>> {
  return db.all(
    "SELECT g.id, g.provider_key_id, k.provider_id, p.name AS provider_name, p.type AS provider_type, k.key_hint, "
      + "g.daily_token_limit, g.daily_request_limit, g.created_at "
      + "FROM user_key_grant g "
      + "JOIN provider_key k ON k.id = g.provider_key_id "
      + "JOIN provider p ON p.id = k.provider_id "
      + "WHERE g.user_id = ? ORDER BY g.created_at",
    [userId],
  );
}

async function listUserGrants(db: AdminDb, userId: string): Promise<Response> {
  if ((await findUser(db, userId)) === null) {
    return jsonError(404, "NOT_FOUND", `user ${userId} not found`);
  }
  return json({ user_id: userId, grants: await userGrantViews(db, userId) });
}

/** 整组替换某用户的授权：校验全部 provider_key 存在，重复提交去重；条目对象可带授权级限额（纯字符串 = 不限额）。 */
async function replaceUserGrants(
  request: Request, db: AdminDb, deps: AdminDeps, now: () => number, actor: string | null, userId: string,
): Promise<Response> {
  const input = GrantsInput.parse(await readJson(request));
  if ((await findUser(db, userId)) === null) {
    return jsonError(404, "NOT_FOUND", `user ${userId} not found`);
  }
  // 纯字符串归一为不限额条目；按 provider_key_id 去重（重复时后见覆盖）。
  const entries = [...new Map(
    input.provider_key_ids.map((e) => [typeof e === "string" ? e : e.provider_key_id, e]),
  ).values()].map((e) =>
    typeof e === "string"
      ? { provider_key_id: e, daily_token_limit: 0, daily_request_limit: 0 }
      : e,
  );
  const ids = entries.map((e) => e.provider_key_id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ");
    const found = await db.all<{ id: string }>(
      `SELECT id FROM provider_key WHERE id IN (${placeholders})`, ids,
    );
    if (found.length !== ids.length) {
      const present = new Set(found.map((r) => r.id));
      const missing = ids.find((k) => !present.has(k));
      return jsonError(404, "NOT_FOUND", `provider_key ${missing} not found`);
    }
  }
  await db.run("DELETE FROM user_key_grant WHERE user_id = ?", [userId]);
  const ts = now();
  for (const entry of entries) {
    await db.run(
      "INSERT INTO user_key_grant (id, user_id, provider_key_id, daily_token_limit, daily_request_limit, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [newId(), userId, entry.provider_key_id, entry.daily_token_limit, entry.daily_request_limit, ts],
    );
  }
  await writeAudit(db, now, actor, "grants.replace", userId, { grants: entries }, deps);
  return json({ user_id: userId, grants: await userGrantViews(db, userId) });
}

// ---- misc ------------------------------------------------------------------------

async function deleteRow(db: AdminDb, deps: AdminDeps, now: () => number, actor: string | null, table: string, id: string, action: string): Promise<Response> {
  const res = await db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  if (!res.changes) return jsonError(404, "NOT_FOUND", `${table} ${id} not found`);
  await writeAudit(db, now, actor, action, id, undefined, deps);
  return json({ deleted: true, id });
}

async function listAudit(db: AdminDb): Promise<Response> {
  return json(await db.all("SELECT * FROM admin_audit ORDER BY ts DESC, rowid DESC LIMIT 100", []));
}

/** from/to 时间窗参数解析（listLogs 与 usage 共用）：缺失→undefined，非数字→"invalid"。 */
function epochParam(params: URLSearchParams, name: "from" | "to"): number | undefined | "invalid" {
  const raw = params.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isNaN(value) ? "invalid" : value;
}

/** epochParam + 统一 400；无效时返回错误响应，否则返回数值窗口。 */
function epochWindow(params: URLSearchParams): { error: Response } | { from?: number; to?: number } {
  const from = epochParam(params, "from");
  if (from === "invalid") {
    return { error: jsonError(400, "BAD_REQUEST", "from must be an epoch-ms integer") };
  }
  const to = epochParam(params, "to");
  if (to === "invalid") {
    return { error: jsonError(400, "BAD_REQUEST", "to must be an epoch-ms integer") };
  }
  return { from, to };
}

/**
 * Cursor-paginated log query (ticket 08, spec §3.7): keyset pagination on
 * (ts, id) — new rows arriving mid-pagination never cause duplicates or
 * skips. Cursor format "<ts>:<id>" (opaque to the client).
 */
async function listLogs(db: AdminDb, url: URL, identity: AdminIdentity): Promise<Response> {
  const params = url.searchParams;
  const limitRaw = Number.parseInt(params.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 50 : limitRaw, 1), 100);

  const conditions: string[] = [];
  const values: unknown[] = [];
  // 范围钉定（desktop 04，同 usage 范式）：user 角色只回自己的行（本地镜像
  // 同步/原始日志面板据此工作）；administrator 全局。
  if (identity.role !== "administrator") {
    if (identity.userId === null) conditions.push("1 = 0");
    else {
      conditions.push("user_id = ?");
      values.push(identity.userId);
    }
  }
  const model = params.get("model");
  const provider = params.get("provider");
  const window = epochWindow(params);
  if ("error" in window) return window.error;
  if (window.from !== undefined) {
    conditions.push("ts >= ?");
    values.push(window.from);
  }
  if (window.to !== undefined) {
    conditions.push("ts <= ?");
    values.push(window.to);
  }
  if (model !== null) {
    conditions.push("client_model = ?");
    values.push(model);
  }
  if (provider !== null) {
    conditions.push("provider_id = ?");
    values.push(provider);
  }
  const cursor = params.get("cursor");
  if (cursor !== null) {
    const sep = cursor.lastIndexOf(":");
    const cursorTs = Number(cursor.slice(0, sep));
    const cursorId = cursor.slice(sep + 1);
    if (Number.isNaN(cursorTs) || cursorId.length === 0) {
      return jsonError(400, "BAD_REQUEST", "invalid cursor");
    }
    conditions.push("(ts < ? OR (ts = ? AND id < ?))");
    values.push(cursorTs, cursorTs, cursorId);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await db.all<Record<string, unknown>>(
    `SELECT * FROM request_log ${where} ORDER BY ts DESC, id DESC LIMIT ?`,
    [...values, limit + 1],
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1] as { ts: number; id: string } | undefined;
  return json({
    logs: page,
    next_cursor: hasMore && last ? `${last.ts}:${last.id}` : null,
  });
}

// ---- usage aggregation（multi-user 05）------------------------------------------

const USAGE_GROUP_BYS = { key: "access_key_id", model: "client_model" } as const;

interface UsageAggregateRow {
  dim: string | null;
  requests: number;
  errors: number;
  prompt_tokens: number;
  completion_tokens: number;
  avg_latency_ms: number | null;
}

/**
 * GET /admin/usage（multi-user 05）：SQL GROUP BY 聚合请求数、错误数
 * （status ≥ 400）、prompt/completion tokens 合计与平均延迟。参数：from/to
 * （epoch ms）、access_key_id、group_by=key|model（缺省不分组）、user_id（仅
 * administrator 可用）。user 角色永远只聚合自己的行——范围在 SQL 层强制
 * （WHERE user_id = 身份），不做响应后过滤。空窗口返回零值结构而非报错。
 */
async function usageAggregate(db: AdminDb, url: URL, identity: AdminIdentity): Promise<Response> {
  const params = url.searchParams;
  const window = epochWindow(params);
  if ("error" in window) return window.error;
  const groupByRaw = params.get("group_by");
  let groupBy: keyof typeof USAGE_GROUP_BYS | undefined;
  if (groupByRaw !== null) {
    if (groupByRaw !== "key" && groupByRaw !== "model") {
      return jsonError(400, "BAD_REQUEST", "group_by must be \"key\" or \"model\"");
    }
    groupBy = groupByRaw;
  }
  const admin = identity.role === "administrator";
  const userFilter = params.get("user_id");
  if (userFilter !== null && !admin) {
    return jsonError(403, "FORBIDDEN", "the user_id filter is administrator-only");
  }

  // 范围钉定：user 角色恒为自身；administrator 可选按 user_id 收窄，缺省全局
  // （含无归属的历史行，按 key 分组时落在 null 维度）。
  const conditions: string[] = [];
  const values: unknown[] = [];
  const scopeUserId = admin ? userFilter : identity.userId;
  if (scopeUserId !== null) {
    conditions.push("user_id = ?");
    values.push(scopeUserId);
  }
  const accessKeyId = params.get("access_key_id");
  if (accessKeyId !== null) {
    conditions.push("access_key_id = ?");
    values.push(accessKeyId);
  }
  if (window.from !== undefined) {
    conditions.push("ts >= ?");
    values.push(window.from);
  }
  if (window.to !== undefined) {
    conditions.push("ts <= ?");
    values.push(window.to);
  }

  const dimColumn = groupBy === undefined ? null : USAGE_GROUP_BYS[groupBy];
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await db.all<UsageAggregateRow>(
    `SELECT ${dimColumn ? `${dimColumn} AS dim, ` : ""}COUNT(*) AS requests, `
      + `COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors, `
      + `COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0) AS prompt_tokens, `
      + `COALESCE(SUM(COALESCE(completion_tokens, 0)), 0) AS completion_tokens, `
      + `COALESCE(CAST(AVG(latency_ms) AS INTEGER), 0) AS avg_latency_ms `
      + `FROM request_log ${where} `
      + `${dimColumn ? `GROUP BY ${dimColumn} ORDER BY ${dimColumn}` : ""}`,
    values,
  );

  // 分组行以维度列（access_key_id / client_model）为键；无归属的历史行在管理
  // 员全局视图按 key 分组时落在 null 维度。
  const usage = rows.map((r) => ({
    ...(dimColumn === null ? {} : { [dimColumn]: r.dim }),
    requests: r.requests,
    errors: r.errors,
    prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens,
    avg_latency_ms: r.avg_latency_ms ?? 0,
  }));
  return json({ group_by: groupBy ?? null, usage });
}

/**
 * 备份信封版本（desktop 06）：格式演进时递增；恢复脚本拒识不支持的版本。
 * 1 = { version, exported_at, providers, keys(密文), mappings, users(无哈希),
 *       grants(含配额), access_keys(元数据), audit }。
 */
export const EXPORT_VERSION = 1;

/** 备份导出的 key 列（密文口径）：与 KEY_COLUMNS 同族但含 encrypted_key、略去瞬时态。 */
const EXPORT_KEY_COLUMNS = "id, provider_id, encrypted_key, key_hint, enabled, daily_token_limit, daily_request_limit, management_credentials, created_at, updated_at";

/** 备份导出的访问 key 列（元数据）：与 ACCESS_KEY_COLUMNS 同族但永不含 key_hash。 */
const EXPORT_ACCESS_KEY_COLUMNS = "id, user_id, name, key_hint, enabled, expires_at, ip_allowlist, daily_token_limit, daily_request_limit, max_concurrency, created_at, updated_at";

/**
 * GET /admin/export（desktop 06 扩容）：灾备密文快照——provider key 以
 * encrypted_key 密文原样导出（恢复前提 = 同一把 ENCRYPTION_KEY）；key 行
 * 管控面凭证（management_credentials，provider-usage 04）同密文口径随行；
 * 用户/授权（含配额）/访问 key 元数据/审计全量随行。任何字段不含哈希或明文：
 * management_token / access_key 的 key_hash 列永不出现，lgm_/lgk_ 明文
 * 本就只在发放响应中出现一次。
 */
async function exportConfig(db: AdminDb, now: () => number): Promise<Response> {
  const [providers, keys, mappings, users, grants, accessKeys, audit] = await Promise.all([
    providerViews(db),
    db.all(`SELECT ${EXPORT_KEY_COLUMNS} FROM provider_key ORDER BY created_at`, []),
    db.all("SELECT * FROM model_mapping ORDER BY client_model", []),
    db.all("SELECT id, name, role, enabled, created_at, updated_at FROM user ORDER BY created_at", []),
    db.all(
      "SELECT id, user_id, provider_key_id, daily_token_limit, daily_request_limit, created_at "
      + "FROM user_key_grant ORDER BY created_at",
      [],
    ),
    db.all(`SELECT ${EXPORT_ACCESS_KEY_COLUMNS} FROM access_key ORDER BY created_at`, []),
    db.all("SELECT id, ts, action, target, detail, actor_user_id FROM admin_audit ORDER BY ts, rowid", []),
  ]);
  return json({
    version: EXPORT_VERSION,
    exported_at: now(),
    providers,
    keys,
    mappings,
    users,
    grants,
    access_keys: accessKeys,
    audit,
  });
}

/**
 * POST /admin/keys/:id/test（可选 body { model }）：服务端解密该 Key 后
 * 直连所属供应商发最小 chat 请求，明文不出服务端。model 缺省时优先取
 * 该供应商启用映射的 upstream_model，否则回退到预置目录的建议模型。
 */
async function testKeyById(request: Request, deps: AdminDeps, keyId: string): Promise<Response> {
  if (!deps.encryptionKey) {
    return jsonError(500, "INTERNAL", "ENCRYPTION_KEY is not configured");
  }
  const rows = await deps.db.all<Record<string, unknown>>(
    "SELECT k.id AS key_id, k.encrypted_key, p.id AS provider_id, p.name, p.type FROM provider_key k JOIN provider p ON p.id = k.provider_id WHERE k.id = ?",
    [keyId],
  );
  if (rows.length === 0) return jsonError(404, "NOT_FOUND", `key ${keyId} not found`);
  const row = rows[0]!;

  let model: string | undefined;
  let protocol: Protocol | undefined;
  try {
    const body = (await request.json()) as { model?: unknown; protocol?: unknown };
    if (typeof body?.model === "string" && body.model.length > 0) model = body.model;
    if (body?.protocol !== undefined) {
      if (!PROTOCOLS.some((value) => value === body.protocol)) {
        return jsonError(400, "BAD_REQUEST", `pass a supported protocol: ${PROTOCOLS.join(", ")}`);
      }
      protocol = body.protocol as Protocol;
    }
  } catch {
    // body 可省略
  }
  // 端点选择：指定协议取之；未指定取该供应商唯一/第一个端点。
  const endpoints = await deps.db.all<{ protocol: string; base_url: string }>(
    "SELECT protocol, base_url FROM provider_endpoint WHERE provider_id = ?",
    [row.provider_id as string],
  );
  const chosen = protocol === undefined ? endpoints[0] : endpoints.find((e) => e.protocol === protocol);
  if (!chosen) {
    const detail = protocol === undefined ? "no endpoints" : `no ${protocol} endpoint`;
    return jsonError(400, "BAD_REQUEST", `this provider has ${detail} configured`);
  }
  if (!model) {
    const mapping = await deps.db.all<{ upstream_model: string }>(
      "SELECT upstream_model FROM model_mapping WHERE provider_id = ? AND enabled = 1 LIMIT 1",
      [row.provider_id as string],
    );
    model =
      mapping[0]?.upstream_model
      ?? findPresetProvider(row.type as string)?.suggested_models[0]
      ?? undefined;
  }
  if (!model) {
    return jsonError(400, "BAD_REQUEST", "no model available: pass { \"model\" } or configure a mapping");
  }

  const encryptionKey = deps.encryptionKey; // narrow after the guard above
  let apiKey: string;
  try {
    const cryptoKey = await importEncryptionKey(encryptionKey);
    apiKey = await decryptApiKey(cryptoKey, row.encrypted_key as string);
  } catch {
    return jsonError(500, "INTERNAL", "failed to decrypt key (ENCRYPTION_KEY mismatch?)");
  }

  const result: KeyTestResult = await runKeyTest(
    { baseUrl: chosen.base_url, apiKey, model, protocol: chosen.protocol as Protocol },
    deps.testFetcher,
  );
  return json({ key_id: keyId, model, protocol: chosen.protocol, ...result });
}

/**
 * 连通性测试服务端转发（03）：POST /admin/providers/:id/test——body 带手输明文
 * api_key，服务端按 protocol 取对应端点直连上游（runKeyTest 缝）。此前客户端
 * 直连依赖上游允许 CORS（智谱回显任意 origin 可通，火山方舟无 CORS 头 → 桌面
 * WebView 报 Load failed，请求根本没出门）。明文 Key 只在本请求内使用：不落库、
 * 不进审计、不回显；测试请求不入冷却计数。
 */
async function testProviderById(request: Request, deps: AdminDeps, providerId: string): Promise<Response> {
  const providers = await deps.db.all<{ id: string; type: string }>(
    "SELECT id, type FROM provider WHERE id = ?",
    [providerId],
  );
  if (providers.length === 0) return jsonError(404, "NOT_FOUND", `provider ${providerId} not found`);
  const providerType = providers[0]!.type;

  let apiKey = "";
  let model: string | undefined;
  let protocol: Protocol | undefined;
  try {
    const body = (await request.json()) as { api_key?: unknown; model?: unknown; protocol?: unknown };
    if (typeof body?.api_key === "string" && body.api_key.length >= 4) apiKey = body.api_key;
    if (typeof body?.model === "string" && body.model.length > 0) model = body.model;
    if (PROTOCOLS.some((value) => value === body?.protocol)) protocol = body.protocol as Protocol;
  } catch {
    // body 必填（api_key/protocol），缺失走下方 400。
  }
  if (apiKey === "") {
    return jsonError(400, "BAD_REQUEST", "pass { \"api_key\" } (min 4 chars) to test");
  }
  if (protocol === undefined) {
    return jsonError(400, "BAD_REQUEST", `pass a supported protocol: ${PROTOCOLS.join(", ")}`);
  }
  const endpoints = await deps.db.all<{ protocol: string; base_url: string }>(
    "SELECT protocol, base_url FROM provider_endpoint WHERE provider_id = ?",
    [providerId],
  );
  const chosen = endpoints.find((e) => e.protocol === protocol);
  if (!chosen) {
    return jsonError(400, "BAD_REQUEST", `this provider has no ${protocol} endpoint configured`);
  }
  if (!model) {
    const mapping = await deps.db.all<{ upstream_model: string }>(
      "SELECT upstream_model FROM model_mapping WHERE provider_id = ? AND enabled = 1 LIMIT 1",
      [providerId],
    );
    model = mapping[0]?.upstream_model ?? findPresetProvider(providerType)?.suggested_models[0] ?? undefined;
  }
  if (!model) {
    return jsonError(400, "BAD_REQUEST", "no model available: pass { \"model\" } or configure a mapping");
  }

  const result: KeyTestResult = await runKeyTest(
    { baseUrl: chosen.base_url, apiKey, model, protocol },
    deps.testFetcher,
  );
  return json({ provider_id: providerId, protocol, model, ...result });
}

/**
 * 上游模型发现（model-discovery 01）：GET /admin/providers/:id/models——服务端
 * 解密该供应商一把启用 Key，逐端点 GET 上游 models 列表（openai 优先，失败依次
 * 回退其余协议端点）。明文 Key 不出服务端；全部失败返回 502 供 UI 回落静态清单。
 * 只读、不入冷却计数（列表请求不耗 tokens）。
 */
async function listProviderModels(deps: AdminDeps, providerId: string): Promise<Response> {
  if (!deps.encryptionKey) {
    return jsonError(500, "INTERNAL", "ENCRYPTION_KEY is not configured");
  }
  const providers = await deps.db.all<{ type: string }>("SELECT type FROM provider WHERE id = ?", [providerId]);
  if (providers.length === 0) return jsonError(404, "NOT_FOUND", `provider ${providerId} not found`);
  const endpoints = await deps.db.all<{ protocol: string; base_url: string }>(
    "SELECT protocol, base_url FROM provider_endpoint WHERE provider_id = ?",
    [providerId],
  );
  if (endpoints.length === 0) {
    return jsonError(400, "BAD_REQUEST", "this provider has no endpoints configured");
  }
  const preset = findPresetProvider(providers[0]!.type);
  const documented = preset?.model_list_protocols;
  const discoverable = documented === undefined
    ? endpoints
    : endpoints.filter((endpoint) => documented.some((protocol) => protocol === endpoint.protocol));
  if (discoverable.length === 0) {
    return jsonError(400, "BAD_REQUEST", "no documented model list for the configured protocols");
  }
  const keyRows = await deps.db.all<{ encrypted_key: string }>(
    "SELECT encrypted_key FROM provider_key WHERE provider_id = ? AND enabled = 1 LIMIT 1",
    [providerId],
  );
  if (keyRows.length === 0) {
    return jsonError(400, "BAD_REQUEST", "this provider has no enabled key; add one first");
  }
  let apiKey: string;
  try {
    const cryptoKey = await importEncryptionKey(deps.encryptionKey);
    apiKey = await decryptApiKey(cryptoKey, keyRows[0]!.encrypted_key);
  } catch {
    return jsonError(500, "INTERNAL", "failed to decrypt key (ENCRYPTION_KEY mismatch?)");
  }
  // 端点尝试顺序：openai 列表语义最标准 → responses → anthropic → gemini。
  const order = ["openai", "responses", "anthropic", "gemini"];
  const sorted = [...discoverable].sort(
    (a, b) => (order.indexOf(a.protocol) + 1 || order.length) - (order.indexOf(b.protocol) + 1 || order.length),
  );
  const errors: string[] = [];
  for (const ep of sorted) {
    const result = await fetchUpstreamModels(
      { baseUrl: ep.base_url, apiKey, protocol: ep.protocol as Protocol, query: preset?.model_list_query },
      deps.testFetcher,
    );
    if (result.ok) {
      return json({ provider_id: providerId, protocol: ep.protocol, models: result.models });
    }
    errors.push(`${ep.protocol}: ${result.error ?? "failed"}`);
  }
  return jsonError(502, "UPSTREAM_ERROR", `model list unavailable (${errors.join("; ")})`);
}

/**
 * 套餐窗口配额 adapter 缝（provider-usage 01/02/04）：按供应商 type 分发，
 * 归一化为统一窗口列表。内存 TTL 缓存 ~5 分钟防刷上游（改凭证后读到旧值
 * ≤5 分钟，UI 刷新按钮可绕）；只读、不入冷却计数。无 adapter 的供应商类型
 * （custom 等）→ 400 USAGE_UNSUPPORTED，UI 据此不渲染用量区。
 * needs = 该 adapter 的凭证来源：key（智谱档解密 key 本体）｜credentials
 * （火山档解密 key 行 management_credentials AK/SK）。
 */
type UsageAdapter = (
  ctx: { baseUrl?: string; apiKey?: string; credentials?: ManagementCredentials },
  fetcher: Fetcher | undefined,
  now: () => number,
) => Promise<UsageResult>;

/** 凭证需求：credentials = 管控面凭证（火山档）；key = 推理 Key（智谱档）。 */
const fetchZhipuAdapter = (ctx: Parameters<UsageAdapter>[0], fetcher: Fetcher | undefined, now: () => number) =>
  fetchZhipuUsage({ baseUrl: ctx.baseUrl ?? "", apiKey: ctx.apiKey ?? "" }, fetcher, now);
const USAGE_ADAPTERS: Record<string, { needs: "credentials" | "key"; fetch: UsageAdapter }> = {
  // 智谱两个 preset（标准 GLM / Coding Plan）共用同一用量端点；标准账号大概率
  // 也返回有效 limits，解析失败自然落「用量不可用」。
  zhipu: { needs: "key", fetch: fetchZhipuAdapter },
  "zhipu-coding": { needs: "key", fetch: fetchZhipuAdapter },
  // 火山档凭证来自 management_credentials（AK/SK），不依赖推理 Key；常规推理
  // 与 AgentPlan 编程套餐两个 preset 共用同一 adapter（AK/SK 是 IAM 账号级，
  // 不分入口）。
  volcengine: {
    needs: "credentials",
    fetch: (ctx, fetcher, now) => fetchVolcengineUsage({ credentials: ctx.credentials! }, fetcher, now),
  },
  "volcengine-plan": {
    needs: "credentials",
    fetch: (ctx, fetcher, now) => fetchVolcengineUsage({ credentials: ctx.credentials! }, fetcher, now),
  },
};

const USAGE_TTL_MS = 5 * 60_000;
/** 模块级 TTL 缓存（worker isolate / server 进程各自内存态，key = key id）。 */
const usageCache = new Map<string, { expiresAt: number; body: unknown }>();
/** 有用量 adapter 的供应商类型（UI 据此决定是否渲染/拉取用量区）。 */
export const PROVIDER_USAGE_TYPES: readonly string[] = Object.keys(USAGE_ADAPTERS);

/**
 * 套餐窗口配额（provider-usage 04，key 级）：GET /admin/keys/:id/usage——用量是
 * 上游账号维度的，key 是账号身份的代理（供应商可挂多把 key 且可属不同账号，
 * provider 级查询在多账号时必然歧义）。凭证按 adapter 需求取自该 key 行：
 * 智谱档解密推理 Key 本体，火山档解密 key 行的 management_credentials（AK/SK）。
 * 其余口径（TTL/refresh=1/不入冷却/专用错误码）同 01/02。
 */
async function getKeyUsage(deps: AdminDeps, keyId: string, refresh = false): Promise<Response> {
  const now = deps.now ?? (() => Date.now());
  const cached = usageCache.get(keyId);
  if (!refresh && cached && cached.expiresAt > now()) {
    return json(cached.body);
  }
  if (!deps.encryptionKey) {
    return jsonError(500, "INTERNAL", "ENCRYPTION_KEY is not configured");
  }
  const keyRows = await deps.db.all<{
    id: string;
    encrypted_key: string | null;
    management_credentials: string | null;
    provider_type: string;
  }>(
    "SELECT k.id, k.encrypted_key, k.management_credentials, p.type AS provider_type "
    + "FROM provider_key k JOIN provider p ON p.id = k.provider_id WHERE k.id = ?",
    [keyId],
  );
  if (keyRows.length === 0) return jsonError(404, "NOT_FOUND", `key ${keyId} not found`);
  const row = keyRows[0]!;
  const providerType = row.provider_type;
  const adapter = USAGE_ADAPTERS[providerType];
  if (!adapter) {
    // 专用错误码（而非 BAD_REQUEST）：UI 靠 code 判定「整格不渲染」，消息匹配太脆。
    return jsonError(400, "USAGE_UNSUPPORTED", `usage not supported for provider type "${providerType}"`);
  }
  const cryptoKey = await importEncryptionKey(deps.encryptionKey);
  const ctx: { baseUrl?: string; apiKey?: string; credentials?: ManagementCredentials } = {};

  if (adapter.needs === "credentials") {
    // 管控面凭证路径（火山档）：解密 + schema 校验（形态漂移即 500，密文坏损同理）；
    // 没填凭证 → 400 USAGE_NO_CREDENTIALS（UI 渲染引导态，不要求推理 Key）。
    if (!row.management_credentials) {
      return jsonError(400, "USAGE_NO_CREDENTIALS", "this key has no management credentials; add IAM AK/SK to enable usage queries");
    }
    try {
      ctx.credentials = ManagementCredentialsSchema.parse(
        JSON.parse(await decryptApiKey(cryptoKey, row.management_credentials)),
      );
    } catch {
      return jsonError(500, "INTERNAL", "failed to decrypt management credentials (ENCRYPTION_KEY mismatch?)");
    }
  } else {
    // 推理 Key 路径（智谱档）：用量端点只看主机（origin），取 openai 端点优先。
    const endpoints = await deps.db.all<{ protocol: string; base_url: string }>(
      "SELECT pe.protocol, pe.base_url FROM provider_endpoint pe "
      + "JOIN provider_key k ON k.provider_id = pe.provider_id WHERE k.id = ?",
      [keyId],
    );
    const endpoint = endpoints.find((ep) => ep.protocol === "openai") ?? endpoints[0];
    if (!endpoint) {
      return jsonError(400, "BAD_REQUEST", "this provider has no endpoints configured");
    }
    ctx.baseUrl = endpoint.base_url;
    try {
      ctx.apiKey = await decryptApiKey(cryptoKey, row.encrypted_key!);
    } catch {
      return jsonError(500, "INTERNAL", "failed to decrypt key (ENCRYPTION_KEY mismatch?)");
    }
  }

  const result = await adapter.fetch(ctx, deps.testFetcher, now);
  if (!result.ok) {
    if (result.kind === "no_credentials") {
      return jsonError(400, "USAGE_NO_CREDENTIALS", result.error);
    }
    return jsonError(502, "UPSTREAM_ERROR", result.error);
  }
  const body = { key_id: keyId, provider_type: providerType, ...result.usage };
  usageCache.set(keyId, { expiresAt: now() + USAGE_TTL_MS, body });
  return json(body);
}
