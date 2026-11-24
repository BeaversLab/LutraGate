/**
 * SQLite schema for the server form — identical to spec §3.3 and to
 * packages/worker/migrations/0001_init.sql (D1). Keep all three in sync.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS provider (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'custom',
  enabled INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 1,
  cooldown_failure_threshold INTEGER NOT NULL DEFAULT 0,
  cooldown_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_endpoint (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  UNIQUE(provider_id, protocol)
);
CREATE TABLE IF NOT EXISTS provider_key (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
  encrypted_key TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  daily_token_limit INTEGER NOT NULL DEFAULT 0,
  daily_request_limit INTEGER NOT NULL DEFAULT 0,
  management_credentials TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_mapping (
  id TEXT PRIMARY KEY,
  client_model TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
  upstream_model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(client_model, provider_id)
);
CREATE TABLE IF NOT EXISTS request_log (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  client_model TEXT NOT NULL, upstream_model TEXT,
  provider_id TEXT, key_id TEXT,
  user_id TEXT, access_key_id TEXT,
  prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER,
  latency_ms INTEGER, status INTEGER NOT NULL,
  error_type TEXT, error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_ts ON request_log(ts);
CREATE INDEX IF NOT EXISTS idx_log_model ON request_log(client_model);
-- idx_log_user / idx_log_access_key 依赖多用户新增列，在 migrate() 里建
-- （旧库先补列再建索引；新库列由本 DDL 创建，索引同样由 migrate 补上）。
CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL,
  action TEXT NOT NULL, target TEXT, detail TEXT, actor_user_id TEXT
);
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('administrator', 'user')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS management_token (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_key (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL DEFAULT 0,
  ip_allowlist TEXT NOT NULL DEFAULT '[]',
  daily_token_limit INTEGER NOT NULL DEFAULT 0,
  daily_request_limit INTEGER NOT NULL DEFAULT 0,
  max_concurrency INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_key_grant (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider_key_id TEXT NOT NULL REFERENCES provider_key(id) ON DELETE CASCADE,
  daily_token_limit INTEGER NOT NULL DEFAULT 0,
  daily_request_limit INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, provider_key_id)
);
`;

export interface MigrateDb {
  exec(sql: string): unknown;
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/**
 * 旧库升级（等价于 D1 migrations 0002/0003，已应用则跳过）：
 * 0002 provider.type；0003 端点表 + base_url 搬迁 + 删列。
 */
export function migrate(db: MigrateDb): void {
  try {
    db.exec("ALTER TABLE provider ADD COLUMN type TEXT NOT NULL DEFAULT 'custom'");
  } catch {
    // 列已存在（新库由 DDL 直接创建）
  }
  const columns = db.prepare("PRAGMA table_info(provider)").all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === "base_url")) {
    db.exec(
      `INSERT OR IGNORE INTO provider_endpoint (id, provider_id, protocol, base_url)
       SELECT 'migrated-' || id, id, 'openai', base_url FROM provider WHERE base_url IS NOT NULL AND base_url != ''`,
    );
    db.exec("ALTER TABLE provider DROP COLUMN base_url");
  }
  // 0004 多用户：审计加操作者列（新库由 DDL 直接创建）。
  try {
    db.exec("ALTER TABLE admin_audit ADD COLUMN actor_user_id TEXT");
  } catch {
    // 列已存在
  }
  // 0006 多用户：请求日志归属列与索引（新库列由 DDL 直接创建）。索引必须
  // 在列补齐后建——放在 DDL 里会在未升级的旧库上报 no such column。
  for (const column of ["user_id", "access_key_id"]) {
    try {
      db.exec(`ALTER TABLE request_log ADD COLUMN ${column} TEXT`);
    } catch {
      // 列已存在
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_log_user ON request_log(user_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_log_access_key ON request_log(access_key_id)");
  // 0011：key_id 索引（Key 管理列表 last_used_at 子查询）。
  db.exec("CREATE INDEX IF NOT EXISTS idx_log_key ON request_log(key_id)");
  // 0012 日志错误详情（打磨轮 B）：上游失败截断摘要；新库由 DDL 直接创建。
  try {
    db.exec("ALTER TABLE request_log ADD COLUMN error_message TEXT");
  } catch {
    // 列已存在
  }
  // 0013 缓存命中列（usage-cached）：命中量并入 prompt_tokens 后另列记录；
  // 新库由 DDL 直接创建。
  try {
    db.exec("ALTER TABLE request_log ADD COLUMN cached_tokens INTEGER");
  } catch {
    // 列已存在
  }
  // 0007 配额（quota 01）：三表限额列（新库由 DDL 直接创建）。0 = 不限。
  const quotaColumns: Array<[table: string, column: string]> = [
    ["access_key", "daily_token_limit"],
    ["access_key", "daily_request_limit"],
    ["access_key", "max_concurrency"],
    ["user_key_grant", "daily_token_limit"],
    ["user_key_grant", "daily_request_limit"],
    ["provider_key", "daily_token_limit"],
    ["provider_key", "daily_request_limit"],
  ];
  for (const [table, column] of quotaColumns) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // 列已存在
    }
  }
  // 0008 访问控制（access-control 01）：凭证生命周期与冷却覆盖（新库由 DDL
  // 直接创建）。0/空 = 不启用。ip_allowlist 是 JSON 字符串数组（双栈 CIDR）。
  const accessControlColumns: Array<[table: string, column: string, definition: string]> = [
    ["access_key", "expires_at", "INTEGER NOT NULL DEFAULT 0"],
    ["access_key", "ip_allowlist", "TEXT NOT NULL DEFAULT '[]'"],
    ["management_token", "expires_at", "INTEGER NOT NULL DEFAULT 0"],
    ["management_token", "last_used_at", "INTEGER NOT NULL DEFAULT 0"],
    ["provider", "cooldown_failure_threshold", "INTEGER NOT NULL DEFAULT 0"],
    ["provider", "cooldown_ms", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [table, column, definition] of accessControlColumns) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch {
      // 列已存在
    }
  }
  // 0010 凭证下沉 key 级（provider-usage 04）：provider_key 加列；provider 列
  // 删除（0009 引入，生产无数据；旧库可能两态都存在，DROP 防御性 try/catch）。
  try {
    db.exec("ALTER TABLE provider_key ADD COLUMN management_credentials TEXT");
  } catch {
    // 列已存在
  }
  try {
    db.exec("ALTER TABLE provider DROP COLUMN management_credentials");
  } catch {
    // 列已删除（新库由 0010 迁移或从未有过）
  }
}
