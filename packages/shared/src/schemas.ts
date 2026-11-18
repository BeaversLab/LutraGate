import { z } from "zod";
import { CUSTOM_PROVIDER_TYPE } from "./presets";

/**
 * Data schemas mirroring docs/spec.md §3.3 (shared DDL for D1 and SQLite).
 *
 * Conventions:
 * - Column names follow the DDL (snake_case) so adapters can map rows 1:1.
 * - SQLite INTEGER 0/1 booleans surface as `boolean` here; adapters convert.
 * - Timestamps are epoch milliseconds (INTEGER columns).
 */

/** nanoid primary key (21 chars, A-Za-z0-9_-). */
const nanoid = z.string().regex(/^[A-Za-z0-9_-]{21}$/);

/** Epoch milliseconds. */
const epochMs = z.number().int().nonnegative();

/**
 * 限额数字（quota，roadmap v1.1）：非负整数，0 = 不限。三级限额
 * （场景级 access_key / 授权级 user_key_grant / 资产级 provider_key）
 * 统一用这一语义。
 */
const quotaLimit = z.number().int().nonnegative().default(0);

/** Standard base64 (charset + padding only; length is context-dependent). */
const base64 = z.string().regex(
  /^[A-Za-z0-9+/]+={0,2}$/,
  "must be base64",
);

/**
 * 上游协议（与端点表 protocol 列一致；新协议 = 改这里 + 对应转发器）：
 * - openai：/v1/chat/completions（Authorization: Bearer）
 * - anthropic：/v1/messages（x-api-key + anthropic-version）
 * - gemini：/v1beta/models/{model}:generateContent（x-goog-api-key）
 * - responses：/v1/responses（OpenAI Responses API，Bearer）
 */
export const PROTOCOLS = ["openai", "anthropic", "gemini", "responses"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** 按协议配置的上游端点；至少配置一个。 */
export const ProviderEndpointsSchema = z
  .object({
    openai: z.url().optional(),
    anthropic: z.url().optional(),
    gemini: z.url().optional(),
    responses: z.url().optional(),
  })
  .refine((e) => Object.values(e).some((url) => url !== undefined), {
    message: "at least one endpoint is required",
  });

export const ProviderSchema = z.object({
  id: nanoid,
  name: z.string().min(1),
  /** 供应商类型（预置目录 id 或 "custom"），见 presets.ts。 */
  type: z.string().min(1).default(CUSTOM_PROVIDER_TYPE),
  endpoints: ProviderEndpointsSchema,
  enabled: z.boolean().default(true),
  weight: z.number().int().positive().default(1),
  /** 冷却覆盖（access-control）：0 = 全局默认（3 次/60s）。 */
  cooldown_failure_threshold: quotaLimit,
  cooldown_ms: quotaLimit,
  created_at: epochMs,
  updated_at: epochMs,
});
export type Provider = z.output<typeof ProviderSchema>;

export const ProviderKeySchema = z.object({
  id: nanoid,
  provider_id: nanoid,
  /** base64(iv|ciphertext|tag) — plaintext keys never appear here. */
  encrypted_key: base64,
  /** Last 4 characters of the plaintext key, for display only. */
  key_hint: z.string().length(4),
  enabled: z.boolean().default(true),
  /** Epoch ms; persisted for display only, runtime cooldown lives in memory. */
  cooldown_until: epochMs.default(0),
  failure_count: z.number().int().nonnegative().default(0),
  /** 资产级限额（quota）：该上游 key 的跨用户日预算总闸；0 = 不限。 */
  daily_token_limit: quotaLimit,
  daily_request_limit: quotaLimit,
  created_at: epochMs,
  updated_at: epochMs,
});
export type ProviderKey = z.output<typeof ProviderKeySchema>;

export const ModelMappingSchema = z.object({
  id: nanoid,
  client_model: z.string().min(1),
  provider_id: nanoid,
  upstream_model: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type ModelMapping = z.output<typeof ModelMappingSchema>;

export const RequestLogEntrySchema = z.object({
  id: nanoid,
  request_id: z.string().min(1),
  ts: epochMs,
  client_model: z.string().min(1),
  upstream_model: z.string().min(1).optional(),
  provider_id: nanoid.optional(),
  key_id: nanoid.optional(),
  /** 归属（多用户）：发起请求的用户与其访问 key；历史行可空。 */
  user_id: nanoid.optional(),
  access_key_id: nanoid.optional(),
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  latency_ms: z.number().int().nonnegative().optional(),
  /** HTTP status of the upstream response (or 0 for network errors). */
  status: z.number().int(),
  error_type: z.string().min(1).optional(),
  /** 错误详情摘要（打磨轮 B）：上游失败时截断（≤500 字符）；成功/历史行为空。 */
  error_message: z.string().min(1).optional(),
});
export type RequestLogEntry = z.output<typeof RequestLogEntrySchema>;

export const AdminAuditSchema = z.object({
  id: nanoid,
  ts: epochMs,
  action: z.string().min(1),
  target: z.string().min(1).optional(),
  detail: z.string().optional(),
  /** 操作者（多用户）；引导/CF Access 虚拟管理员为空。 */
  actor_user_id: nanoid.optional(),
});
export type AdminAudit = z.output<typeof AdminAuditSchema>;

/** 用户角色（多用户）：administrator 管理全局配置与用户；user 仅自助。 */
export const USER_ROLES = ["administrator", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const UserSchema = z.object({
  id: nanoid,
  name: z.string().min(1),
  role: z.enum(USER_ROLES),
  enabled: z.boolean().default(true),
  created_at: epochMs,
  updated_at: epochMs,
});
export type User = z.output<typeof UserSchema>;

/**
 * 持久化的管理 token（lgm_ 前缀）：只存 SHA-256 哈希，明文仅在创建/重置
 * 响应中出现一次。生效条件 = token 启用 且 所属用户启用。
 */
export const ManagementTokenSchema = z.object({
  id: nanoid,
  user_id: nanoid,
  token_hash: z.string().length(64),
  key_hint: z.string().length(4),
  enabled: z.boolean().default(true),
  /** 过期时间（access-control）：0 = 永不过期；admin 鉴权实时查库判定。 */
  expires_at: quotaLimit,
  /** 最近一次成功命中（access-control）：系统内联写入，0 = 从未使用。 */
  last_used_at: quotaLimit,
  created_at: epochMs,
  updated_at: epochMs,
});
export type ManagementToken = z.output<typeof ManagementTokenSchema>;

/**
 * 配置快照中的用户可见性（多用户 ticket 04）：热路径鉴权只需要「用户是否
 * 启用」，完整用户资料留在管理面。
 */
export const ConfigUserSchema = z.object({
  id: nanoid,
  enabled: z.boolean().default(true),
});
export type ConfigUser = z.output<typeof ConfigUserSchema>;

/**
 * 配置快照中的访问 key：只含哈希与归属，明文永不进入快照。命中条件 =
 * key 启用 且 所属用户启用。
 */
export const ConfigAccessKeySchema = z.object({
  id: nanoid,
  user_id: nanoid,
  key_hash: z.string().length(64),
  enabled: z.boolean().default(true),
  /** 场景级限额（quota）：用户自设的日预算与并发上限；0 = 不限。 */
  daily_token_limit: quotaLimit,
  daily_request_limit: quotaLimit,
  max_concurrency: quotaLimit,
  /**
   * 过期与来源网络（access-control）：expires_at 0 = 永不过期（快照判定，
   * 接受 ≤30s 延迟）；ip_allowlist 为 IPv4+IPv6 双栈 CIDR 列表，空 = 不限。
   */
  expires_at: quotaLimit,
  ip_allowlist: z.array(z.string()).default([]),
});
export type ConfigAccessKey = z.output<typeof ConfigAccessKeySchema>;

/** 配置快照中的授权：user → 被授权的上游 provider_key。 */
export const ConfigGrantSchema = z.object({
  user_id: nanoid,
  provider_key_id: nanoid,
  /** 授权级限额（quota）：管理员为该次分配设的日预算；0 = 不限。 */
  daily_token_limit: quotaLimit,
  daily_request_limit: quotaLimit,
});
export type ConfigGrant = z.output<typeof ConfigGrantSchema>;

/** Active gateway configuration aggregate (spec §3.1 ConfigStore). */
export const GatewayConfigSchema = z
  .object({
    providers: z.array(ProviderSchema),
    keys: z.array(ProviderKeySchema),
    mappings: z.array(ModelMappingSchema),
    /** 多用户快照（ticket 04）：key 索引、用户可见性与授权并入缓存。 */
    users: z.array(ConfigUserSchema).default([]),
    access_keys: z.array(ConfigAccessKeySchema).default([]),
    grants: z.array(ConfigGrantSchema).default([]),
  })
  .superRefine((config, ctx) => {
    // UNIQUE(client_model, provider_id) from the DDL (spec §3.3).
    const seen = new Set<string>();
    for (const m of config.mappings) {
      const pair = `${m.client_model}\u0000${m.provider_id}`;
      if (seen.has(pair)) {
        ctx.addIssue({
          code: "custom",
          path: ["mappings"],
          message: `duplicate mapping for client_model "${m.client_model}" and provider ${m.provider_id}`,
        });
        return;
      }
      seen.add(pair);
    }
  });
export type GatewayConfig = z.output<typeof GatewayConfigSchema>;
