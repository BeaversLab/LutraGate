import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { LogDb } from "./logdb";
import { contractRow, runLogStoreContract, runPerEnvIsolationContract } from "./logstore.contract";
import { dexieDbName } from "./logstore.detect";

/** Dexie 实现跑全套契约（desktop 02；SQLite 实现见 03 票）。 */
runLogStoreContract("Dexie", async () => {
  const db = new LogDb(`contract-${Math.random().toString(36).slice(2)}`);
  await db.open();
  return db;
});

/** 按 env id 分库档（multi-env 03）：库名路由 = detectLogStore 的 Web 分支。
 * SQLite 侧不跑本档——内存 fake 执行器按 open 各自隔离，「不同名互不可见」恒真；
 * 桌面命名路由由 sqliteDbUrl + detect 测试锁定（真库走桌面联验）。 */
runPerEnvIsolationContract("Dexie", async (envId) => {
  const db = new LogDb(dexieDbName(envId));
  await db.open();
  return db;
});

describe("Dexie LogStore 范围下推", () => {
  it("listLogs/count with bounds go through where('ts'), not full-table scan + filter", async () => {
    const db = new LogDb(`pushdown-${Math.random().toString(36).slice(2)}`);
    await db.open();
    await db.bulkPut([contractRow(100), contractRow(200), contractRow(300)]);

    // 拦截 Table.where：断言范围查询真的走了 ts 索引下推。
    const whereCalls: string[] = [];
    const originalWhere = db.logs.where.bind(db.logs);
    (db.logs as { where: unknown }).where = (...args: Parameters<typeof originalWhere>) => {
      whereCalls.push(String(args[0]));
      return originalWhere(...args);
    };

    expect((await db.listLogs(200, 300)).length).toBe(2);
    expect(await db.count(200, 300)).toBe(2);
    expect(whereCalls).toEqual(["ts", "ts"]);

    // 无界查询保持旧的全表路径（toArray/count），不经 where —— 行为零变化。
    expect((await db.listLogs()).length).toBe(3);
    expect(await db.count()).toBe(3);
    expect(whereCalls).toEqual(["ts", "ts"]);
  });
});
