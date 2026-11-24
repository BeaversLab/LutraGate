import type { LogRow } from "./api";
import type { LogStore } from "./logstore";

/**
 * 本地日志镜像的 SQLite 实现（desktop 03，spec D4）：桌面私库（tauri-plugin-sql，
 * app 数据目录），**永久保留、无任何自动剪除**。SQL 全部参数化；ts 范围查询以
 * `WHERE ts BETWEEN` 下推，其余过滤留聚合纯函数（单一聚合来源不破）。
 * vitest 够不到 Tauri IPC → 构造器为纯函数、经 SqlExecutor 缝注入（fake 跑契约）；
 * 真库走票内手工验收。
 */

/** 列镜像 LogRow（api.ts），顺序即 SQL 列序/参数序。 */
export const LOG_COLUMNS = [
  "id",
  "request_id",
  "ts",
  "client_model",
  "upstream_model",
  "provider_id",
  "key_id",
  "prompt_tokens",
  "cached_tokens",
  "completion_tokens",
  "latency_ms",
  "status",
  "error_type",
  "error_message",
  "user_id",
  "access_key_id",
] as const;

/** tauri-plugin-sql 的 SQLite 连接串：按 env id 分库（multi-env 01）——`lutragate-<id>.db`，
 * 落在 app 数据目录；旧单库 lutragate.db 不读不写（不做存量迁移）。 */
export function sqliteDbUrl(envId: string): string {
  return `sqlite:lutragate-${envId.replace(/[^A-Za-z0-9_-]/g, "")}.db`;
}

/** tauri-plugin-sql Database 的最小面（execute/select），测试注入 fake 用。 */
export interface SqlExecutor {
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** 建表 DDL（幂等，IF NOT EXISTS）：logs 列镜像 LogRow + ts 索引；meta 存同步游标等。 */
export function schemaSql(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  client_model TEXT NOT NULL,
  upstream_model TEXT,
  provider_id TEXT,
  key_id TEXT,
  prompt_tokens INTEGER,
  cached_tokens INTEGER,
  completion_tokens INTEGER,
  latency_ms INTEGER,
  status INTEGER NOT NULL,
  error_type TEXT,
  error_message TEXT,
  user_id TEXT,
  access_key_id TEXT
)`,
    "CREATE INDEX IF NOT EXISTS logs_ts ON logs(ts)",
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ];
}

/** 覆盖式写入（主键冲突 REPLACE；顺序执行 → 批内同 id 后者胜）。 */
export function insertLogSql(): { sql: string } {
  return { sql: `INSERT OR REPLACE INTO logs (${LOG_COLUMNS.join(", ")}) VALUES (${LOG_COLUMNS.map(() => "?").join(", ")})` };
}

/** 行 → 参数向量（列序一致）；error_message 在旧镜像行上缺省 → 归 null。 */
export function logRowParams(row: LogRow): unknown[] {
  return LOG_COLUMNS.map((col) => row[col] ?? null);
}

/** 查已存在 id：bulkPut 返回「真正新增」数用。 */
export function selectExistingIdsSql(ids: string[]): { sql: string; params: string[] } {
  return {
    sql: `SELECT id FROM logs WHERE id IN (${ids.map(() => "?").join(", ")})`,
    params: ids,
  };
}

export function maxTsSql(): { sql: string } {
  return { sql: "SELECT MAX(ts) AS max_ts FROM logs" };
}

export function getMetaSql(key: string): { sql: string; params: [string] } {
  return { sql: "SELECT value FROM meta WHERE key = ?", params: [key] };
}

/** meta 覆盖写（upsert）；值 JSON 序列化保留类型。 */
export function setMetaSql(key: string, value: unknown): { sql: string; params: [string, string] } {
  return {
    sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    params: [key, JSON.stringify(value)],
  };
}

/** 清空该环境的全部镜像数据（multi-env 04，spec 删除环境）：先幂等建表（环境库可能
 * 从未打开过——建了环境但没进过面板），再清空两表；验收断言 = 读取为空。 */
export function clearAllDataSql(): string[] {
  return [...schemaSql(), "DELETE FROM logs", "DELETE FROM meta"];
}

/** ts 范围子句（闭区间）：只下推 ts，模型/供应商等过滤留聚合纯函数。 */
function tsWhere(from: number | undefined, to: number | undefined): { clause: string; params: number[] } {
  if (from === undefined && to === undefined) return { clause: "", params: [] };
  if (to === undefined) return { clause: " WHERE ts >= ?", params: [from!] };
  if (from === undefined) return { clause: " WHERE ts <= ?", params: [to] };
  return { clause: " WHERE ts BETWEEN ? AND ?", params: [from, to] };
}

export function listLogsSql(from?: number, to?: number): { sql: string; params: number[] } {
  const where = tsWhere(from, to);
  return { sql: `SELECT ${LOG_COLUMNS.join(", ")} FROM logs${where.clause}`, params: where.params };
}

export function countSql(from?: number, to?: number): { sql: string; params: number[] } {
  const where = tsWhere(from, to);
  return { sql: `SELECT COUNT(*) AS n FROM logs${where.clause}`, params: where.params };
}

export class SqliteLogStore implements LogStore {
  private constructor(private readonly db: SqlExecutor) {}

  /** 打开即建表（幂等 DDL）；桌面入口见 loadDesktopLogStore。 */
  static async open(executor: SqlExecutor): Promise<SqliteLogStore> {
    for (const ddl of schemaSql()) await executor.execute(ddl);
    // 存量环境库补列（error_message，打磨轮 B；cached_tokens，usage-cached）。
    // 新库由上面的 DDL 直接创建。ALTER 对已含该列的库抛错——catch 即「列已存在」，
    // 与 server migrate() 同范式。
    try {
      await executor.execute("ALTER TABLE logs ADD COLUMN error_message TEXT");
    } catch {
      // 列已存在
    }
    try {
      await executor.execute("ALTER TABLE logs ADD COLUMN cached_tokens INTEGER");
    } catch {
      // 列已存在
    }
    return new SqliteLogStore(executor);
  }

  async bulkPut(rows: LogRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    // 先查已存在 id：返回「真正新增」数；写入顺序执行 → 批内同 id 后者胜（语义同 Dexie 实现）。
    const ids = [...new Set(rows.map((r) => r.id))];
    const select = selectExistingIdsSql(ids);
    const existing = await this.db.select<{ id: string }>(select.sql, select.params);
    const existingIds = new Set(existing.map((r) => r.id));
    const insert = insertLogSql();
    for (const row of rows) await this.db.execute(insert.sql, logRowParams(row));
    return ids.length - existingIds.size;
  }

  async maxTs(): Promise<number> {
    const rows = await this.db.select<{ max_ts: number | null }>(maxTsSql().sql);
    return rows[0]?.max_ts ?? 0;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const { sql, params } = getMetaSql(key);
    const rows = await this.db.select<{ value: string }>(sql, params);
    const value = rows[0]?.value;
    return value !== undefined ? (JSON.parse(value) as T) : undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const { sql, params } = setMetaSql(key, value);
    await this.db.execute(sql, params);
  }

  async listLogs(from?: number, to?: number): Promise<LogRow[]> {
    const { sql, params } = listLogsSql(from, to);
    return this.db.select<LogRow>(sql, params);
  }

  async count(from?: number, to?: number): Promise<number> {
    const { sql, params } = countSql(from, to);
    const rows = await this.db.select<{ n: number }>(sql, params);
    return rows[0]?.n ?? 0;
  }
}

/** 桌面入口：动态加载 tauri-plugin-sql（Web 构建不打包该 chunk，零构建期分叉），按 env id 分库。 */
export async function loadDesktopLogStore(envId: string): Promise<SqliteLogStore> {
  const { default: Database } = await import("@tauri-apps/plugin-sql");
  return SqliteLogStore.open(await Database.load(sqliteDbUrl(envId)));
}
