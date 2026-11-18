import { describe, expect, it } from "vitest";
import type { LogRow } from "./api";
import type { LogStore } from "./logstore";

/**
 * LogStore 接口契约套件（desktop 02）：定义五能力语义，任何实现（Dexie /
 * SQLite[03]）都必须通过。以「新建空 store」的 setup 注入，每条用例独立。
 */

let seq = 0;
export function contractRow(ts: number, overrides: Partial<LogRow> = {}): LogRow {
  return {
    id: `row-${seq++}`,
    request_id: "r",
    ts,
    client_model: "m1",
    upstream_model: null,
    provider_id: "p1",
    key_id: null,
    prompt_tokens: 1,
    completion_tokens: 1,
    latency_ms: 10,
    status: 200,
    user_id: null,
    access_key_id: null,
    error_type: null,
    ...overrides,
  };
}

export function runLogStoreContract(name: string, setup: () => Promise<LogStore>): void {
  describe(`LogStore 契约 — ${name}`, () => {
    it("bulkPut is idempotent: re-putting the same rows inserts nothing", async () => {
      const store = await setup();
      const rows = [contractRow(100), contractRow(100), contractRow(200)]; // 同 ts 重复窗口

      expect(await store.bulkPut(rows)).toBe(3);
      expect(await store.bulkPut(rows)).toBe(0);
      expect(await store.count()).toBe(3);
    });

    it("bulkPut overwrites existing ids (later wins) and counts only genuinely new ids", async () => {
      const store = await setup();
      const first = contractRow(100, { prompt_tokens: 1 });
      await store.bulkPut([first]);

      const updated = { ...first, prompt_tokens: 99 };
      const fresh = contractRow(300);
      // 批内同 id 重复：以最后一行为准，新增计数按去重后的 id 数。
      expect(await store.bulkPut([updated, fresh, { ...fresh, prompt_tokens: 5 }])).toBe(1);

      const rows = await store.listLogs();
      expect(rows.find((r) => r.id === first.id)?.prompt_tokens).toBe(99);
      expect(rows.find((r) => r.id === fresh.id)?.prompt_tokens).toBe(5);
      expect(await store.count()).toBe(2);
    });

    it("bulkPut of an empty batch is a no-op returning 0", async () => {
      const store = await setup();
      expect(await store.bulkPut([])).toBe(0);
      expect(await store.count()).toBe(0);
    });

    it("maxTs returns 0 on an empty store and the max ts otherwise", async () => {
      const store = await setup();
      expect(await store.maxTs()).toBe(0);

      await store.bulkPut([contractRow(100), contractRow(500), contractRow(300)]);
      expect(await store.maxTs()).toBe(500);
    });

    it("meta round-trips typed values and reads missing keys as undefined", async () => {
      const store = await setup();
      expect(await store.getMeta<string>("resumeCursor")).toBeUndefined();

      await store.setMeta("resumeCursor", "500:abc");
      await store.setMeta("lastSyncAt", 123456);
      expect(await store.getMeta<string>("resumeCursor")).toBe("500:abc");
      expect(await store.getMeta<number>("lastSyncAt")).toBe(123456);

      // 覆盖写。
      await store.setMeta("resumeCursor", null);
      expect(await store.getMeta<string | null>("resumeCursor")).toBeNull();
    });

    it("listLogs returns everything when unbounded", async () => {
      const store = await setup();
      await store.bulkPut([contractRow(100), contractRow(200), contractRow(300)]);
      expect((await store.listLogs()).length).toBe(3);
    });

    it("listLogs applies an inclusive [from, to] ts range (endpoints included)", async () => {
      const store = await setup();
      await store.bulkPut([contractRow(100), contractRow(200), contractRow(300), contractRow(400)]);

      const both = await store.listLogs(200, 300);
      expect(both.map((r) => r.ts).sort()).toEqual([200, 300]);

      // 半开：只有 from（无上界）/ 只有 to（无下界）。
      expect((await store.listLogs(300)).map((r) => r.ts).sort()).toEqual([300, 400]);
      expect((await store.listLogs(undefined, 200)).map((r) => r.ts).sort()).toEqual([100, 200]);

      // 空范围。
      expect(await store.listLogs(500, 600)).toEqual([]);
    });

    it("count honors the same ts range semantics", async () => {
      const store = await setup();
      await store.bulkPut([contractRow(100), contractRow(200), contractRow(300), contractRow(400)]);

      expect(await store.count()).toBe(4);
      expect(await store.count(200, 300)).toBe(2);
      expect(await store.count(300)).toBe(2);
      expect(await store.count(undefined, 200)).toBe(2);
      expect(await store.count(500, 600)).toBe(0);
    });
  });
}

/**
 * 按 env id 分库契约档（multi-env 03，spec Testing Decisions）：同构造器不同名 →
 * 两库互不可见（行与 meta 同步游标各自独立）——行为等价即分库正确。
 * openByEnvId 由各实现注入自己的「env id → 库名」路由。
 */
export function runPerEnvIsolationContract(
  name: string,
  openByEnvId: (envId: string) => Promise<LogStore>,
): void {
  describe(`LogStore 契约 — ${name} · 按 env id 分库`, () => {
    it("同构造器不同 env id 的两库互不可见（行与 meta 游标独立）", async () => {
      const home = await openByEnvId("env-home");
      const work = await openByEnvId("env-work");

      await home.bulkPut([contractRow(100, { id: "home-1", provider_id: "home-provider" })]);
      await work.bulkPut([
        contractRow(100, { id: "work-1" }),
        contractRow(200, { id: "work-2" }),
      ]);
      await home.setMeta("resumeCursor", "home-cursor");

      expect((await home.listLogs()).map((r) => r.id)).toEqual(["home-1"]);
      expect((await work.listLogs()).map((r) => r.id).sort()).toEqual(["work-1", "work-2"]);
      expect(await home.getMeta<string>("resumeCursor")).toBe("home-cursor");
      // 家里的游标不在公司的库里（切回续传从各自 meta 起，互不污染）。
      expect(await work.getMeta<string>("resumeCursor")).toBeUndefined();
      expect(await home.count()).toBe(1);
      expect(await work.count()).toBe(2);
    });
  });
}
