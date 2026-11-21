import type { Protocol } from "@lutragate/shared";
/**
 * 管理 API 客户端（PRD §8）：统一携带 X-Admin-Token，解析统一错误结构
 * { error: { code, message } }。fetch 可注入便于测试。
 */

import { normalizeBaseUrl } from "./envs";
import type { ManagementCredentials, ProviderUsage } from "@lutragate/core";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AdminApiOptions {
  baseUrl: string;
  /** 经 x-admin-token 头发送的管理面凭证（多用户时代为 lgm_；引导期可为 ADMIN_TOKEN）。 */
  adminToken: string;
  fetcher?: FetchLike;
}

/** 管理端行类型（SQLite/D1 原样：enabled 为 0/1 整数）。 */
export interface ProviderRow {
  id: string;
  name: string;
  /** 预置供应商类型 id 或 "custom"（shared presets）。 */
  type: string;
  /** 按协议配置的上游端点；至少一项（协议见 shared PROTOCOLS）。 */
  endpoints: Record<string, string | undefined>;
  enabled: number;
  weight: number;
  /** 冷却覆盖（access-control）：0 = 全局默认（3 次 / 60s）。 */
  cooldown_failure_threshold: number;
  cooldown_ms: number;
  created_at: number;
  updated_at: number;
}

export interface KeyRow {
  id: string;
  provider_id: string;
  key_hint: string;
  enabled: number;
  cooldown_until: number;
  failure_count: number;
  /** 资产级限额（quota）：该上游 key 的跨用户日预算总闸；0 = 不限。 */
  daily_token_limit: number;
  daily_request_limit: number;
  created_at: number;
  updated_at: number;
  /** 最近一次经此 Key 的请求时间（request_log MAX(ts)）；无日志为 null/缺省。 */
  last_used_at?: number | null;
}

/** 套餐窗口配额（provider-usage 04，key 级）：GET /admin/keys/:id/usage 响应体（windows 形态从 core 单源引入，防两端漂移）。 */
export type KeyUsageBody = { key_id: string; provider_type: string } & ProviderUsage;

export interface MappingRow {
  id: string;
  client_model: string;
  provider_id: string;
  upstream_model: string;
  enabled: number;
}

// ---- 多用户（tickets 01-05）行类型 ------------------------------------------------

/** 用户角色（与服务端 USER_ROLES 一致）。 */
export type Role = "administrator" | "user";

/** GET /admin/me 身份；虚拟管理员（引导/CF Access）id 与 name 为 null。 */
export interface Identity {
  id: string | null;
  name: string | null;
  role: Role;
}

export interface UserRow {
  id: string;
  name: string;
  role: Role;
  /** server userView 投影为布尔（区别于 provider/key 行的 0/1 整数）。 */
  enabled: boolean;
  created_at: number;
  updated_at: number;
  /** 随行 lgm_ 视图（access-control）：无 token 行时为 0/空（永不过期/从未使用）。 */
  token_expires_at: number;
  token_last_used_at: number;
  token_hint: string;
}

/** 创建用户 / 重置 token 的响应：lgm_ 明文仅此一次。 */
export interface CreatedUser extends UserRow {
  management_token: string;
  token_hint: string;
}

export interface ResetTokenResult {
  user_id: string;
  management_token: string;
  token_hint: string;
}

export interface GrantRow {
  id: string;
  provider_key_id: string;
  provider_id: string;
  provider_name: string;
  /** 供应商 preset type（dash-status 02）：个人盘套餐用量卡判渲染用。 */
  provider_type: string;
  key_hint: string;
  /** 授权级限额（quota）：管理员为该次分配设的日预算；0 = 不限。 */
  daily_token_limit: number;
  daily_request_limit: number;
  created_at: number;
}

/** PUT grants 的条目对象（quota）：预算数字缺省 0 = 不限；纯字符串向后兼容。 */
export interface GrantEntry {
  provider_key_id: string;
  daily_token_limit?: number;
  daily_request_limit?: number;
}

export interface GrantsResult {
  user_id: string;
  grants: GrantRow[];
}

/** 访问 key（user 视角）：服务端返回 enabled 为布尔值（区别于 0/1 行）。 */
export interface AccessKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hint: string;
  enabled: boolean;
  /** 场景级限额（quota）：用户自设的日预算与并发上限；0 = 不限。 */
  daily_token_limit: number;
  daily_request_limit: number;
  max_concurrency: number;
  /** 过期与来源网络（access-control）：0 = 永不过期；空列表 = 不限。 */
  expires_at: number;
  ip_allowlist: string[];
  created_at: number;
  updated_at: number;
}

/** 创建访问 key 的响应：lgk_ 明文仅此一次。 */
export interface CreatedAccessKey extends AccessKeyRow {
  access_key: string;
}

/** GET /admin/me/grants：被分配的上游 key + 按授权可达的模型。 */
export interface MyGrantsResult extends GrantsResult {
  models: string[];
}

/** /admin/usage 聚合行；分组维度列为 access_key_id 或 client_model（或无）。 */
export interface UsageRow {
  access_key_id?: string | null;
  client_model?: string | null;
  requests: number;
  errors: number;
  prompt_tokens: number;
  completion_tokens: number;
  avg_latency_ms: number;
}

export interface UsageResult {
  group_by: "key" | "model" | null;
  usage: UsageRow[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** /admin/logs 行（DB 原样：enabled 之类的列为整数，token 列可空）。 */
export interface LogRow {
  id: string;
  request_id: string;
  ts: number;
  client_model: string;
  upstream_model: string | null;
  provider_id: string | null;
  key_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  status: number;
  error_type: string | null;
  /** 错误详情摘要（打磨轮 B）：上游失败截断落库；旧行/成功路径缺省。 */
  error_message?: string | null;
  /** 归属（多用户）：历史行可空。 */
  user_id: string | null;
  access_key_id: string | null;
}

export interface KeyTestOutcome {
  key_id: string;
  model: string;
  protocol: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  replyPreview?: string;
}

export interface LogsPage {
  logs: LogRow[];
  next_cursor: string | null;
}

export class AdminApi {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly fetcher: FetchLike;

  constructor(options: AdminApiOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.adminToken = options.adminToken;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const resp = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "x-admin-token": this.adminToken,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!resp.ok) {
      let code = "INTERNAL";
      let message = `HTTP ${resp.status}`;
      try {
        const body = (await resp.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
      } catch {
        // 非 JSON 错误体 — 保留默认信息
      }
      throw new ApiError(resp.status, code, message);
    }
    return resp.status === 204 ? (undefined as T) : ((await resp.json()) as T);
  }

  // ---- providers ----
  listProviders(): Promise<ProviderRow[]> {
    return this.request("/admin/providers");
  }
  createProvider(body: { name: string; type?: string; endpoints: Record<string, string | undefined>; weight?: number; enabled?: boolean; cooldown_failure_threshold?: number; cooldown_ms?: number; management_credentials?: ManagementCredentials | null }): Promise<ProviderRow> {
    return this.request("/admin/providers", { method: "POST", body: JSON.stringify(body) });
  }
  updateProvider(id: string, body: { name?: string; type?: string; endpoints?: Record<string, string | undefined>; weight?: number; enabled?: boolean; cooldown_failure_threshold?: number; cooldown_ms?: number; management_credentials?: ManagementCredentials | null }): Promise<ProviderRow> {
    return this.request(`/admin/providers/${id}`, { method: "PUT", body: JSON.stringify(body) });
  }
  deleteProvider(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/admin/providers/${id}`, { method: "DELETE" });
  }
  /** 上游模型发现（model-discovery）：服务端解密 Key 拉上游 models 列表；失败抛错由调用方回落。 */
  listProviderModels(id: string): Promise<{ provider_id: string; protocol: string; models: string[] }> {
    return this.request(`/admin/providers/${id}/models`);
  }
  /** 套餐窗口配额（provider-usage 04，key 级）：服务端按该 key 解密凭证查上游用量；refresh=1 绕过服务端 TTL。 */
  getKeyUsage(id: string, opts: { refresh?: boolean } = {}): Promise<KeyUsageBody> {
    return this.request(`/admin/keys/${id}/usage${opts.refresh ? "?refresh=1" : ""}`);
  }
  /** 连通性测试服务端转发（03）：手输 Key 服务端直连上游，明文不落库不回显。 */
  testProvider(id: string, body: { api_key: string; model?: string; protocol: Protocol }): Promise<KeyTestOutcome & { provider_id: string; protocol: string; model: string }> {
    return this.request(`/admin/providers/${id}/test`, { method: "POST", body: JSON.stringify(body) });
  }

  // ---- keys ----
  listKeys(): Promise<KeyRow[]> {
    return this.request("/admin/keys");
  }
  /** 明文 Key 仅在本次请求中出现，之后只以 key_hint 展示。 */
  createKey(body: { provider_id: string; api_key: string; daily_token_limit?: number; daily_request_limit?: number; management_credentials?: ManagementCredentials | null }): Promise<KeyRow> {
    return this.request("/admin/keys", { method: "POST", body: JSON.stringify(body) });
  }
  setKeyEnabled(id: string, enabled: boolean): Promise<KeyRow> {
    return this.request(`/admin/keys/${id}`, { method: "PUT", body: JSON.stringify({ enabled }) });
  }
  /** 资产级限额编辑（quota）：未传字段保持原值；0 = 不限。 */
  updateKeyLimits(id: string, body: { daily_token_limit?: number; daily_request_limit?: number }): Promise<KeyRow> {
    return this.request(`/admin/keys/${id}`, { method: "PUT", body: JSON.stringify(body) });
  }
  /** 异常恢复：清零失败计数并立即解除冷却。 */
  resetKeyCooldown(id: string): Promise<KeyRow> {
    return this.request(`/admin/keys/${id}`, { method: "PUT", body: JSON.stringify({ reset_cooldown: true }) });
  }
  /** 管控面凭证编辑（provider-usage 04，key 级）：三态——undefined 保留 / null 清除 / 对象替换。 */
  updateKeyCredentials(id: string, management_credentials: ManagementCredentials | null): Promise<KeyRow> {
    return this.request(`/admin/keys/${id}`, { method: "PUT", body: JSON.stringify({ management_credentials }) });
  }
/** Key 级连通性测试：服务端解密后直连供应商，明文不出服务端。 */
  testKey(id: string, opts: { model?: string; protocol?: string } = {}): Promise<KeyTestOutcome> {
    return this.request(`/admin/keys/${id}/test`, {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }
  deleteKey(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/admin/keys/${id}`, { method: "DELETE" });
  }

  // ---- logs ----
  listLogs(params: {
    from?: number;
    to?: number;
    model?: string;
    provider?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<LogsPage> {
    const search = new URLSearchParams();
    if (params.from !== undefined) search.set("from", String(params.from));
    if (params.to !== undefined) search.set("to", String(params.to));
    if (params.model !== undefined) search.set("model", params.model);
    if (params.provider !== undefined) search.set("provider", params.provider);
    if (params.cursor !== undefined) search.set("cursor", params.cursor);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    const qs = search.toString();
    return this.request(`/admin/logs${qs ? `?${qs}` : ""}`);
  }

  // ---- mappings ----
  listMappings(): Promise<MappingRow[]> {
    return this.request("/admin/mappings");
  }
  createMapping(body: { client_model: string; provider_id: string; upstream_model: string; enabled?: boolean }): Promise<MappingRow> {
    return this.request("/admin/mappings", { method: "POST", body: JSON.stringify(body) });
  }
  updateMapping(id: string, body: { client_model?: string; provider_id?: string; upstream_model?: string; enabled?: boolean }): Promise<MappingRow> {
    return this.request(`/admin/mappings/${id}`, { method: "PUT", body: JSON.stringify(body) });
  }
  deleteMapping(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/admin/mappings/${id}`, { method: "DELETE" });
  }

  // ---- identity & users（multi-user 02/03）------------------------------------
  /** 启动时取登录身份；401 = 凭证无效。凭证经 x-admin-token 头携带 lgm_。 */
  getMe(): Promise<Identity> {
    return this.request("/admin/me");
  }
  listUsers(): Promise<UserRow[]> {
    return this.request("/admin/users");
  }
  /** lgm_ 明文只出现在该响应中，之后仅以 token_hint 展示。 */
  createUser(body: { name: string; role: Role }): Promise<CreatedUser> {
    return this.request("/admin/users", { method: "POST", body: JSON.stringify(body) });
  }
  updateUser(id: string, body: { name?: string; role?: Role; enabled?: boolean }): Promise<UserRow> {
    return this.request(`/admin/users/${id}`, { method: "PUT", body: JSON.stringify(body) });
  }
  deleteUser(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/admin/users/${id}`, { method: "DELETE" });
  }
  /** 管理员为指定用户代建访问 key（lgk_ 明文仅此一次；虚拟管理员无 user_id 的唯一途径）。 */
  createUserAccessKey(userId: string, body: { name: string } & Partial<{
    daily_token_limit: number; daily_request_limit: number; max_concurrency: number; expires_at: number; ip_allowlist: string[];
  }>): Promise<CreatedAccessKey> {
    return this.request(`/admin/users/${userId}/access-keys`, { method: "POST", body: JSON.stringify(body) });
  }
  /** 重置管理 token：旧的立即失效，新的 lgm_ 明文仅此一次；可同时设置过期（access-control）。 */
  resetUserToken(id: string, expiresAt?: number): Promise<ResetTokenResult> {
    return this.request(`/admin/users/${id}/token`, {
      method: "POST",
      ...(expiresAt !== undefined ? { body: JSON.stringify({ expires_at: expiresAt }) } : {}),
    });
  }
  /** 只改 lgm_ 过期时间、不轮换明文（续期 ≠ 轮换，access-control）。 */
  updateUserTokenExpiry(id: string, expiresAt: number): Promise<{ user_id: string; expires_at: number; updated_at: number }> {
    return this.request(`/admin/users/${id}/token`, { method: "PUT", body: JSON.stringify({ expires_at: expiresAt }) });
  }
  getUserGrants(id: string): Promise<GrantsResult> {
    return this.request(`/admin/users/${id}/grants`);
  }
  /** 整组替换授权：条目对象可带授权级预算（quota）；纯字符串向后兼容 = 不限额。 */
  replaceUserGrants(id: string, provider_key_ids: Array<string | GrantEntry>): Promise<GrantsResult> {
    return this.request(`/admin/users/${id}/grants`, { method: "PUT", body: JSON.stringify({ provider_key_ids }) });
  }

  // ---- user 自助面（multi-user 07）---------------------------------------------
  /** 当前身份的授权视图：user 角色仅自己的 key（SQL 层钉定）。 */
  listAccessKeys(): Promise<AccessKeyRow[]> {
    return this.request("/admin/access-keys");
  }
  /** lgk_ 明文只出现在该响应中，之后仅以 key_hint 展示。 */
  createAccessKey(body: { name: string; daily_token_limit?: number; daily_request_limit?: number; max_concurrency?: number; expires_at?: number; ip_allowlist?: string[] }): Promise<CreatedAccessKey> {
    return this.request("/admin/access-keys", { method: "POST", body: JSON.stringify(body) });
  }
  updateAccessKey(id: string, body: { name?: string; enabled?: boolean; daily_token_limit?: number; daily_request_limit?: number; max_concurrency?: number; expires_at?: number; ip_allowlist?: string[] }): Promise<AccessKeyRow> {
    return this.request(`/admin/access-keys/${id}`, { method: "PUT", body: JSON.stringify(body) });
  }
  deleteAccessKey(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/admin/access-keys/${id}`, { method: "DELETE" });
  }
  /** 我的授权：被分配的上游 key 与可达模型（与 /v1/models 同一收敛）。 */
  getMyGrants(): Promise<MyGrantsResult> {
    return this.request("/admin/me/grants");
  }
  /** 用量聚合（multi-user 05）；user 角色服务端强制只回自己的数据；user_id 过滤仅 administrator 可用。 */
  getUsage(params: { group_by?: "key" | "model"; from?: number; to?: number; access_key_id?: string; user_id?: string } = {}): Promise<UsageResult> {
    const search = new URLSearchParams();
    if (params.group_by !== undefined) search.set("group_by", params.group_by);
    if (params.from !== undefined) search.set("from", String(params.from));
    if (params.to !== undefined) search.set("to", String(params.to));
    if (params.access_key_id !== undefined) search.set("access_key_id", params.access_key_id);
    if (params.user_id !== undefined) search.set("user_id", params.user_id);
    const qs = search.toString();
    return this.request(`/admin/usage${qs ? `?${qs}` : ""}`);
  }

  // ---- 发布信息（公开 /version，同 /health 口径）--------------------------------
  /** 服务器标签版本 + HEAD + 最近提交记录；旧服务器无该端点 → 404 由调用方回落。 */
  getVersion(): Promise<ServerRelease> {
    return this.request("/version");
  }
}

/** /version 响应（packages/server/src/release.ts 注入，部署脚本生成）。 */
export interface ServerRelease {
  tag: string | null;
  commit: string | null;
  gateway_version?: string;
}
