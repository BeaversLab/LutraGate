import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { LogDb } from "./logdb";
import { contractRow } from "./logstore.contract";
import { deleteLogStoreData, detectLogStore, dexieDbName } from "./logstore.detect";
import type { TauriInternals } from "./tauri";

/** 探测路由（desktop 03 / multi-env 01 分库命名）：Web → Dexie（名含 env id）；Tauri → plugin:sql。 */

describe("detectLogStore", () => {
  it("非 Tauri 环境返回 Dexie 实现，库名按 env id 分库（两环境互不可见）", async () => {
    const store = await detectLogStore("env-1", null);
    expect(store).toBeInstanceOf(LogDb);
    expect((store as LogDb).name).toBe("lutragate-env-1");
    expect(dexieDbName("env-2")).toBe("lutragate-env-2");
  });

  it("Tauri 环境走 SQLite 加载路径：按 env id 连 lutragate-<id>.db 并透传失败", async () => {
    // plugin-sql 内部直接读 window.__TAURI_INTERNALS__（不接受注入），故挂全局再还原。
    const calls: string[] = [];
    const internals: TauriInternals = {
      async invoke(cmd, args) {
        calls.push(`${cmd}:${JSON.stringify(args)}`);
        throw new Error("ipc unavailable in tests");
      },
    };
    const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
    const saved = w.__TAURI_INTERNALS__;
    w.__TAURI_INTERNALS__ = internals;
    try {
      await expect(detectLogStore("env-1", internals)).rejects.toThrow("ipc unavailable in tests");
      expect(calls).toContain('plugin:sql|load:{"db":"sqlite:lutragate-env-1.db"}');
    } finally {
      w.__TAURI_INTERNALS__ = saved;
    }
  });
});

describe("deleteLogStoreData 清库路由（multi-env 04）", () => {
  it("Web：整库删除（Dexie db.delete）——重开同名库读取为空", async () => {
    const store = await detectLogStore("env-del", null);
    await store.bulkPut([contractRow(100), contractRow(200)]);

    await deleteLogStoreData("env-del", null);

    // 重开 = 全新库：行与 meta 都不在（spec 断言口径：读取为空）。
    const reopened = await detectLogStore("env-del", null);
    expect(await reopened.count()).toBe(0);
    expect(await reopened.getMeta<string>("resumeCursor")).toBeUndefined();
  });

  it("Tauri：走 plugin:sql 清空表数据路径并透传 IPC 失败", async () => {
    const calls: string[] = [];
    const internals: TauriInternals = {
      async invoke(cmd, args) {
        calls.push(`${cmd}:${JSON.stringify(args)}`);
        throw new Error("ipc unavailable in tests");
      },
    };
    const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
    const saved = w.__TAURI_INTERNALS__;
    w.__TAURI_INTERNALS__ = internals;
    try {
      await expect(deleteLogStoreData("env-del", internals)).rejects.toThrow("ipc unavailable in tests");
      expect(calls).toContain('plugin:sql|load:{"db":"sqlite:lutragate-env-del.db"}');
    } finally {
      w.__TAURI_INTERNALS__ = saved;
    }
  });
});
