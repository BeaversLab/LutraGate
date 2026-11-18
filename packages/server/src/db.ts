import { Database } from "bun:sqlite";
import type { AdminDb, LogSink, ConfigStore } from "@lutragate/core";
import { SqlConfigStore, REQUEST_LOG_INSERT_SQL, REQUEST_LOG_RETENTION_SQL, requestLogParams } from "@lutragate/core";
import type { RequestLogEntry } from "@lutragate/shared";
import { DDL, migrate } from "./schema";

/**
 * bun:sqlite implementations of the core ports (ticket 09): opens (and
 * auto-migrates) the database, and provides the AdminDb / ConfigStore /
 * LogSink used by the shared gateway and admin handlers.
 */

export function openDb(path = "lutragate.db"): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DDL); // single source of DDL; IF NOT EXISTS makes it idempotent
  // migrate 依赖 DDL 先建好新表（如 provider_endpoint 接收 base_url 搬迁），
  // 且引用新列的索引在其内部于补列之后创建。
  migrate(db); // best-effort column upgrades for pre-existing databases
  return db;
}

/** AdminDb port over bun:sqlite. */
export class SqliteAdminDb implements AdminDb {
  constructor(private readonly db: Database) {}

  async all<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as import("bun:sqlite").SQLQueryBindings[])) as T[];
  }

  async run(sql: string, params: unknown[]): Promise<{ changes: number }> {
    const info = this.db.prepare(sql).run(...(params as import("bun:sqlite").SQLQueryBindings[]));
    return { changes: info.changes };
  }
}

export { SqlConfigStore };

/** ConfigStore alias for callers importing from this module. */
export type { ConfigStore };

export const LOG_RETENTION_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * LogSink port: synchronous SQLite write (microseconds for a local file)
 * returning an already-resolved promise — the gateway handler invokes this
 * fire-and-forget, so the proxy path never waits, and callers that do await
 * (or track via waitUntil) always observe the completed write. (Bun's
 * queueMicrotask defers to the next event-loop tick, which made the write
 * unobservable to awaiters — hence synchronous, not microtask-deferred.)
 * Retention cleanup rides along best-effort (spec §3.3).
 */
export class SqliteLogSink implements LogSink {
  constructor(
    private readonly db: Database,
    private readonly options: { now?: () => number } = {},
  ) {}

  write(entry: RequestLogEntry): Promise<void> {
    try {
      const now = this.options.now ?? Date.now;
      this.db.prepare(REQUEST_LOG_INSERT_SQL).run(
        ...(requestLogParams(entry) as import("bun:sqlite").SQLQueryBindings[]),
      );
      this.db
        .prepare(REQUEST_LOG_RETENTION_SQL)
        .run(now() - LOG_RETENTION_DAYS * DAY_MS);
    } catch (err) {
      console.warn("request log write failed silently:", err);
    }
    return Promise.resolve();
  }
}
