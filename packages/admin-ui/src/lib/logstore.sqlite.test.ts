import { describe, expect, it } from "vitest";
import type { LogRow } from "./api";
import { contractRow, runLogStoreContract } from "./logstore.contract";
import {
  LOG_COLUMNS,
  SqliteLogStore,
  clearAllDataSql,
  countSql,
  getMetaSql,
  insertLogSql,
  listLogsSql,
  logRowParams,
  maxTsSql,
  schemaSql,
  selectExistingIdsSql,
  setMetaSql,
  sqliteDbUrl,
  type SqlExecutor,
} from "./logstore.sqlite";

/**
 * SQLite LogStore（desktop 03）：vitest 够不到 Tauri IPC，单测分两层——
 * 1) SQL/参数构造器纯函数：语句全参数化、ts 范围走 WHERE ts BETWEEN 下推；
 * 2) 契约套件复用：SqliteLogStore + 内存 fake 执行器（只解释构造器产出的固定
 *    语句形状）锁定五能力语义与 Dexie 一致。真库（tauri-plugin-sql）走票内手工验收。
 */

describe("SQLite 构造器 — 建表", () => {
  it("schema DDL 幂等（IF NOT EXISTS）且覆盖 logs 全列 + ts 索引 + meta 两列", () => {
    const ddl = schemaSql().join("\n");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS logs");
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS meta");
    expect(ddl).toContain("CREATE INDEX IF NOT EXISTS logs_ts ON logs(ts)");
    for (const col of LOG_COLUMNS) expect(ddl).toContain(col);
    expect(ddl).toContain("key TEXT PRIMARY KEY");
    // DDL 无用户值 → 无参数占位符。
    expect(ddl).not.toContain("?");
  });
});

describe("SQLite 构造器 — 全参数化", () => {
  it("insertLogSql 对全部 14 列使用占位符，logRowParams 按列序给出参数", () => {
    const { sql } = insertLogSql();
    expect(sql).toContain("INSERT OR REPLACE INTO logs");
    expect((sql.match(/\?/g) ?? []).length).toBe(LOG_COLUMNS.length);
    expect(sql).not.toMatch(/VALUES \(\d/);

    const row = contractRow(123, { id: "literal-id", prompt_tokens: null });
    const params = logRowParams(row);
    expect(params.length).toBe(LOG_COLUMNS.length);
    expect(params[LOG_COLUMNS.indexOf("id")]).toBe("literal-id");
    expect(params[LOG_COLUMNS.indexOf("ts")]).toBe(123);
    expect(params[LOG_COLUMNS.indexOf("prompt_tokens")]).toBeNull();
    // 行值不得内联进 SQL。
    expect(sql).not.toContain("literal-id");
  });

  it("selectExistingIdsSql 把每个 id 作为参数（IN 占位符与 id 数一致）", () => {
    const { sql, params } = selectExistingIdsSql(["a", "b", "c"]);
    expect(sql).toContain("SELECT id FROM logs WHERE id IN (");
    expect((sql.match(/\?/g) ?? []).length).toBe(3);
    expect(params).toEqual(["a", "b", "c"]);
    expect(sql).not.toContain("'a'");
  });

  it("meta 读写以 key/value 为参数，值 JSON 序列化", () => {
    expect(getMetaSql("resumeCursor")).toEqual({
      sql: "SELECT value FROM meta WHERE key = ?",
      params: ["resumeCursor"],
    });
    const set = setMetaSql("resumeCursor", "500:abc");
    expect(set.sql).toContain("INSERT INTO meta");
    expect(set.sql).toContain("ON CONFLICT(key) DO UPDATE");
    expect(set.params).toEqual(["resumeCursor", '"500:abc"']);
    expect(set.sql).not.toContain("500:abc");
  });

  it("maxTsSql 固定形状、无字面量", () => {
    expect(maxTsSql()).toEqual({ sql: "SELECT MAX(ts) AS max_ts FROM logs" });
  });
});

describe("SQLite 构造器 — ts 范围下推", () => {
  const BASE = `SELECT ${LOG_COLUMNS.join(", ")} FROM logs`;

  it("双侧界走 WHERE ts BETWEEN（闭区间，端点含等值）", () => {
    const q = listLogsSql(200, 300);
    expect(q.sql).toBe(`${BASE} WHERE ts BETWEEN ? AND ?`);
    expect(q.params).toEqual([200, 300]);
    // 大窗口不全量拉取：值永远在参数里，语句形状恒定可被索引下推。
    expect(q.sql).not.toContain("200");
    expect(q.sql).not.toContain("300");
  });

  it("半开界分别下推 >= / <=，无界不带 WHERE（保持全表路径）", () => {
    expect(listLogsSql(300)).toEqual({ sql: `${BASE} WHERE ts >= ?`, params: [300] });
    expect(listLogsSql(undefined, 200)).toEqual({ sql: `${BASE} WHERE ts <= ?`, params: [200] });
    expect(listLogsSql()).toEqual({ sql: BASE, params: [] });
  });

  it("countSql 使用同一 where 形状", () => {
    expect(countSql(200, 300)).toEqual({
      sql: "SELECT COUNT(*) AS n FROM logs WHERE ts BETWEEN ? AND ?",
      params: [200, 300],
    });
    expect(countSql()).toEqual({ sql: "SELECT COUNT(*) AS n FROM logs", params: [] });
  });
});

describe("sqliteDbUrl 分库命名（multi-env 01）", () => {
  it("按 env id 命名：lutragate-<id>.db，旧单库名不再使用", () => {
    expect(sqliteDbUrl("env-1")).toBe("sqlite:lutragate-env-1.db");
    // 防御性清洗：id 里的路径/危险字符剔掉。
    expect(sqliteDbUrl("a/b..c")).toBe("sqlite:lutragate-abc.db");
  });
});

describe("clearAllDataSql 清空镜像数据（multi-env 04）", () => {
  it("先幂等建表（环境库可能从未打开过）再清空 logs 与 meta 两表", () => {
    const sql = clearAllDataSql();
    expect(sql.slice(0, schemaSql().length)).toEqual(schemaSql());
    expect(sql.slice(schemaSql().length)).toEqual(["DELETE FROM logs", "DELETE FROM meta"]);
    // 清空后的库读取为空（验收断言同口径）由 fake 执行器契约覆盖。
  });
});

/**
 * 内存 fake 执行器：不做通用 SQL 解析，只逐一比对 SqliteLogStore 会发出的固定
 * 语句形状（与构造器常量同源），按 SQLite 标准语义（INSERT OR REPLACE 覆盖、
 * BETWEEN 闭区间、meta upsert）解释。真实引擎行为由参数化语句本身 + 手工验收覆盖。
 */
function fakeExecutor(): SqlExecutor {
  const logs = new Map<string, unknown[]>(); // id → 参数向量（LOG_COLUMNS 序）
  const meta = new Map<string, string>();

  const asRows = (): LogRow[] =>
    [...logs.values()].map((v) => {
      const row = {} as Record<string, unknown>;
      LOG_COLUMNS.forEach((col, i) => (row[col] = v[i]));
      return row as unknown as LogRow;
    });

  const rangeFilter = (sql: string, params: unknown[]): LogRow[] => {
    const rows = asRows();
    if (sql === listLogsSql().sql) return rows;
    if (sql === listLogsSql(0, 0).sql) return rows.filter((r) => r.ts >= (params[0] as number) && r.ts <= (params[1] as number));
    if (sql === listLogsSql(0).sql) return rows.filter((r) => r.ts >= (params[0] as number));
    if (sql === listLogsSql(undefined, 0).sql) return rows.filter((r) => r.ts <= (params[0] as number));
    throw new Error(`fake executor: unexpected range shape ${sql}`);
  };

  return {
    async execute(sql: string, params: unknown[] = []) {
      if (schemaSql().includes(sql)) return { rowsAffected: 0 }; // 建表 no-op
      if (sql === insertLogSql().sql) {
        logs.set(String(params[LOG_COLUMNS.indexOf("id")]), [...params]);
        return { rowsAffected: 1 };
      }
      if (sql === setMetaSql("", 0).sql) {
        meta.set(String(params[0]), String(params[1]));
        return { rowsAffected: 1 };
      }
      throw new Error(`fake executor: unexpected execute ${sql}`);
    },
    async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      // 下面的 `setMetaSql("", 0)` / `listLogsSql(0, 0)` 等是「形状探针」：取语句
      // 常量本身做等值比对，dummy 参数值不参与（真正参数以调用处传入的为准）。
      if (sql.startsWith("SELECT id FROM logs WHERE id IN (")) {
        const wanted = new Set(params.map(String));
        return asRows().filter((r) => wanted.has(r.id)).map((r) => ({ id: r.id })) as T[];
      }
      if (sql === maxTsSql().sql) {
        return [{ max_ts: asRows().reduce((m, r) => Math.max(m, r.ts), 0) }] as T[];
      }
      if (sql === getMetaSql("").sql) {
        const value = meta.get(String(params[0]));
        return value === undefined ? ([] as T[]) : ([{ value }] as T[]);
      }
      if (sql.startsWith(`SELECT ${LOG_COLUMNS.join(", ")} FROM logs`)) {
        return rangeFilter(sql, params) as T[];
      }
      if (sql.startsWith("SELECT COUNT(*) AS n FROM logs")) {
        // 把 count 形状换写成 listLogs 形状复用同一套范围判断。
        const listSql = `SELECT ${LOG_COLUMNS.join(", ")}${sql.slice("SELECT COUNT(*) AS n".length)}`;
        return [{ n: rangeFilter(listSql, params).length }] as T[];
      }
      throw new Error(`fake executor: unexpected select ${sql}`);
    },
  };
}

// 契约复用：与实现无关的语义断言对 SqliteLogStore 同样成立（经 fake 执行器）。
runLogStoreContract("SQLite（内存 fake 执行器）", async () => SqliteLogStore.open(fakeExecutor()));
