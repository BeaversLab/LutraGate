import { EXPORT_VERSION } from "@lutragate/core";

/**
 * 备份重放（desktop 06）：把 /admin/export 的版本化信封重放进一个**空**目标
 * 实例——两形态（Worker/Server）通吃，全部走 admin API，无直连数据库差异。
 *
 * 语义（spec desktop 06）：
 * - 先全量预检目标库，冲突 = 同 id 或同名资源 → 输出完整清单并中止，**零写入**；
 * - 重放顺序 providers → keys → mappings → users（每人生成临时 lgm_ 并打印）
 *   → grants（含配额）；新建资源拿到新 id，备份内引用按映射翻译；
 * - provider key 以密文导出、以明文经 api_key 重放（恢复前提 = 同一把
 *   ENCRYPTION_KEY，解密缝注入）；
 * - 访问 key（lgk_ 哈希不可恢复）与审计（只导不回灌）**不在重放范围**。
 *
 * fetch 与 decrypt 均为注入缝：CLI 提供真实现，测试提供假路由。
 */

export type RestoreFetcher = (url: string, init?: RequestInit) => Promise<Response>;

// ---- 备份信封类型（与 core exportConfig 输出结构对应）---------------------------

export interface BackupProvider {
  id: string;
  name: string;
  type: string;
  enabled: number;
  weight: number;
  cooldown_failure_threshold: number;
  cooldown_ms: number;
  endpoints: Record<string, string | undefined>;
}

export interface BackupKey {
  id: string;
  provider_id: string;
  /** 密文（base64(iv|ciphertext|tag)）；恢复时经 decrypt 缝还原为明文重放。 */
  encrypted_key: string;
  key_hint: string;
  enabled: number;
  daily_token_limit: number;
  daily_request_limit: number;
  /** 管控面凭证（provider-usage 04，key 级）：密文（同 ENCRYPTION_KEY 前提），可缺省。 */
  management_credentials?: string;
}

export interface BackupMapping {
  id: string;
  client_model: string;
  provider_id: string;
  upstream_model: string;
  enabled: number;
}

export interface BackupUser {
  id: string;
  name: string;
  role: string;
  enabled: number;
}

export interface BackupGrant {
  id: string;
  user_id: string;
  provider_key_id: string;
  daily_token_limit: number;
  daily_request_limit: number;
}

export interface BackupEnvelope {
  version: number;
  exported_at: number;
  providers: BackupProvider[];
  keys: BackupKey[];
  mappings: BackupMapping[];
  users: BackupUser[];
  grants: BackupGrant[];
  /** 元数据（只读参考，不回灌）。 */
  access_keys?: unknown[];
  /** 台账（只导不回灌）。 */
  audit?: unknown[];
}

// ---- 结果类型 -------------------------------------------------------------------

export interface RestoreConflict {
  resource: "provider" | "provider_key" | "model_mapping" | "user";
  backup_id: string;
  /** 冲突原因（id / 名称 / 映射对）。 */
  detail: string;
}

export interface TempCredential {
  user_id: string;
  name: string;
  /** 一次性 lgm_ 明文：仅恢复运行中可得，请用户立即登录并重置。 */
  management_token: string;
}

export interface RestoreResult {
  status: "replayed" | "aborted";
  conflicts: RestoreConflict[];
  /** 备份 id → 目标库新 id（providers/keys/mappings/users 四类）。 */
  idMap: {
    providers: Record<string, string>;
    keys: Record<string, string>;
    mappings: Record<string, string>;
    users: Record<string, string>;
  };
  tempCredentials: TempCredential[];
  manualSteps: string[];
}

/** 恢复完成后必须人工收尾的清单（runbook 同源）。 */
export const RESTORE_MANUAL_STEPS = [
  "各用户用打印出的临时 lgm_ 登录后立即重置管理 token（旧 lgm_ 哈希不可恢复）",
  "访问 key（lgk_）无法从备份恢复——各用户在「我的 Key」按需重建场景 key",
  "确认目标实例配置了与备份相同的 ENCRYPTION_KEY（否则上游 key 解密/转发失败）",
  "审计日志只导不回灌——完整台账见备份文件的 audit 字段",
];

export interface RestoreDeps {
  baseUrl: string;
  adminToken: string;
  fetcher: RestoreFetcher;
  /** 密文 → 明文（CLI 用 ENCRYPTION_KEY 构造；无 keys 的备份可不提供）。 */
  decrypt?: (encryptedKey: string) => Promise<string>;
}

// ---- 预检（零写入）---------------------------------------------------------------

/** 目标库同 id 或同名资源 → 完整冲突清单；空清单 = 空库语义放行。 */
async function preflight(backup: BackupEnvelope, deps: RestoreDeps): Promise<RestoreConflict[]> {
  const conflicts: RestoreConflict[] = [];
  const get = async <T>(path: string): Promise<T[]> => {
    const resp = await deps.fetcher(`${deps.baseUrl}${path}`, {
      headers: { "x-admin-token": deps.adminToken },
    });
    if (!resp.ok) throw new Error(`preflight GET ${path} failed: HTTP ${resp.status}`);
    return (await resp.json()) as T[];
  };

  const [providers, keys, mappings, users] = await Promise.all([
    get<{ id: string; name: string }>("/admin/providers"),
    get<{ id: string }>("/admin/keys"),
    get<{ id: string; client_model: string; upstream_model: string }>("/admin/mappings"),
    get<{ id: string; name: string }>("/admin/users"),
  ]);

  for (const p of backup.providers) {
    if (providers.some((t) => t.id === p.id)) {
      conflicts.push({ resource: "provider", backup_id: p.id, detail: "id already exists" });
    } else if (providers.some((t) => t.name === p.name)) {
      conflicts.push({ resource: "provider", backup_id: p.id, detail: `name "${p.name}" already exists` });
    }
  }
  for (const k of backup.keys) {
    if (keys.some((t) => t.id === k.id)) {
      conflicts.push({ resource: "provider_key", backup_id: k.id, detail: "id already exists" });
    }
  }
  for (const m of backup.mappings) {
    if (mappings.some((t) => t.id === m.id)) {
      conflicts.push({ resource: "model_mapping", backup_id: m.id, detail: "id already exists" });
    } else if (mappings.some((t) => t.client_model === m.client_model && t.upstream_model === m.upstream_model)) {
      conflicts.push({ resource: "model_mapping", backup_id: m.id, detail: `client_model "${m.client_model}" → "${m.upstream_model}" already exists` });
    }
  }
  for (const u of backup.users) {
    if (users.some((t) => t.id === u.id)) {
      conflicts.push({ resource: "user", backup_id: u.id, detail: "id already exists" });
    } else if (users.some((t) => t.name === u.name)) {
      conflicts.push({ resource: "user", backup_id: u.id, detail: `name "${u.name}" already exists` });
    }
  }
  return conflicts;
}

// ---- 重放 ------------------------------------------------------------------------

export async function restoreBackup(backup: BackupEnvelope, deps: RestoreDeps): Promise<RestoreResult> {
  if (backup.version !== EXPORT_VERSION) {
    throw new Error(`unsupported backup version ${backup.version} (expected ${EXPORT_VERSION}); get a fresh export`);
  }

  const result: RestoreResult = {
    status: "aborted",
    conflicts: [],
    idMap: { providers: {}, keys: {}, mappings: {}, users: {} },
    tempCredentials: [],
    manualSteps: RESTORE_MANUAL_STEPS,
  };

  const conflicts = await preflight(backup, deps);
  if (conflicts.length > 0) {
    return { ...result, conflicts };
  }

  /** 单次 admin 调用：非 2xx 即抛（重放中途失败由操作者重置目标库重来——空库语义）。 */
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const resp = await deps.fetcher(`${deps.baseUrl}${path}`, {
      method,
      headers: { "x-admin-token": deps.adminToken, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!resp.ok) {
      throw new Error(`${method} ${path} failed: HTTP ${resp.status}`);
    }
    return resp.status === 204 ? (undefined as T) : ((await resp.json()) as T);
  };

  // 1) providers（端点/权重/冷却覆盖随行）。
  for (const p of backup.providers) {
    const created = await call<{ id: string }>("POST", "/admin/providers", {
      name: p.name,
      type: p.type,
      endpoints: p.endpoints,
      weight: p.weight,
      enabled: p.enabled !== 0,
      cooldown_failure_threshold: p.cooldown_failure_threshold,
      cooldown_ms: p.cooldown_ms,
    });
    result.idMap.providers[p.id] = created.id;
  }

  // 2) keys：密文经 decrypt 缝还原明文，目标库（同一把 ENCRYPTION_KEY）重新加密
  // 落库；管控面凭证（key 级，provider-usage 04）同样密文解密 → 明文对象重放。
  // 凭证只存在于 key 行上，故 keys 非空即涵盖凭证情形。
  if (backup.keys.length > 0 && deps.decrypt === undefined) {
    throw new Error("backup contains provider keys: a decrypt function (ENCRYPTION_KEY) is required");
  }
  for (const k of backup.keys) {
    const providerId = result.idMap.providers[k.provider_id];
    if (providerId === undefined) {
      throw new Error(`key ${k.id} references unknown provider ${k.provider_id}`);
    }
    let managementCredentials: unknown;
    if (k.management_credentials !== undefined && k.management_credentials !== null) {
      managementCredentials = JSON.parse(await deps.decrypt!(k.management_credentials));
    }
    const created = await call<{ id: string }>("POST", "/admin/keys", {
      provider_id: providerId,
      api_key: await deps.decrypt!(k.encrypted_key),
      enabled: k.enabled !== 0,
      daily_token_limit: k.daily_token_limit,
      daily_request_limit: k.daily_request_limit,
      ...(managementCredentials !== undefined ? { management_credentials: managementCredentials } : {}),
    });
    result.idMap.keys[k.id] = created.id;
  }

  // 3) mappings（provider_id 翻译）。
  for (const m of backup.mappings) {
    const providerId = result.idMap.providers[m.provider_id];
    if (providerId === undefined) {
      throw new Error(`mapping ${m.id} references unknown provider ${m.provider_id}`);
    }
    const created = await call<{ id: string }>("POST", "/admin/mappings", {
      client_model: m.client_model,
      provider_id: providerId,
      upstream_model: m.upstream_model,
      enabled: m.enabled !== 0,
    });
    result.idMap.mappings[m.id] = created.id;
  }

  // 4) users：创建即发新 lgm_（临时凭证，仅此一次）；停用用户补 PUT enabled=false。
  for (const u of backup.users) {
    const created = await call<{ id: string; management_token: string }>("POST", "/admin/users", {
      name: u.name,
      role: u.role,
    });
    result.idMap.users[u.id] = created.id;
    result.tempCredentials.push({ user_id: created.id, name: u.name, management_token: created.management_token });
    if (u.enabled === 0) {
      await call("PUT", `/admin/users/${created.id}`, { enabled: false });
    }
  }

  // 5) grants：按用户整组替换，provider_key_id 翻译 + 配额随行。
  const byUser = new Map<string, BackupGrant[]>();
  for (const g of backup.grants) {
    const list = byUser.get(g.user_id) ?? [];
    list.push(g);
    byUser.set(g.user_id, list);
  }
  for (const [backupUserId, grants] of byUser) {
    const userId = result.idMap.users[backupUserId];
    if (userId === undefined) {
      throw new Error(`grant references unknown user ${backupUserId}`);
    }
    await call("PUT", `/admin/users/${userId}/grants`, {
      // 引用未知上游 key 的授权 = 备份内部不一致（与未知 provider/user 同类
      // 损坏）：抛错而非静默丢行——空库语义下由操作者重置后重来。
      provider_key_ids: grants.map((g) => {
        const keyId = result.idMap.keys[g.provider_key_id];
        if (keyId === undefined) {
          throw new Error(`grant for user ${backupUserId} references unknown provider key ${g.provider_key_id}`);
        }
        return {
          provider_key_id: keyId,
          daily_token_limit: g.daily_token_limit,
          daily_request_limit: g.daily_request_limit,
        };
      }),
    });
  }

  return { ...result, status: "replayed" };
}
