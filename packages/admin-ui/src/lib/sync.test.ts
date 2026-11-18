import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { AdminApi, type LogRow, type LogsPage } from "./api";
import { LogDb } from "./logdb";
import { syncLogsOnce } from "./sync";

function makeApi(pagesByCursor: Map<string | undefined, LogsPage>): AdminApi & { calls: Array<Record<string, string | undefined>> } {
  const calls: Array<Record<string, string | undefined>> = [];
  const api = new AdminApi({
    baseUrl: "http://gw.test",
    adminToken: "t",
    fetcher: async (url) => {
      const parsed = new URL(url);
      const params: Record<string, string | undefined> = {};
      for (const key of ["from", "cursor", "limit"] as const) {
        params[key] = parsed.searchParams.get(key) ?? undefined;
      }
      calls.push(params);
      const page = pagesByCursor.get(params.cursor);
      if (!page) throw new Error(`unexpected cursor: ${params.cursor}`);
      return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return Object.assign(api, { calls });
}

let seq = 0;
function log(ts: number, overrides: Partial<LogRow> = {}): LogRow {
  return {
    id: `log-${seq++}`,
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

describe("syncLogsOnce", () => {
  let db: LogDb;

  beforeEach(async () => {
    db = new LogDb(`test-${Math.random().toString(36).slice(2)}`);
    await db.open();
  });

  it("pulls all pages from scratch and stores them", async () => {
    const page1 = { logs: [log(100), log(200)], next_cursor: "100:abc" };
    const page2 = { logs: [log(300)], next_cursor: null };
    const api = makeApi(new Map<string | undefined, LogsPage>([[undefined, page1], ["100:abc", page2]]));

    const result = await syncLogsOnce(api, db);
    expect(result).toEqual({ inserted: 3, pages: 2, truncated: false });
    expect(await db.logs.count()).toBe(3);
    // 首次全量拉取不带 from。
    expect(api.calls[0]!.from).toBeUndefined();
    expect(api.calls[1]!.cursor).toBe("100:abc");
  });

  it("is idempotent: re-pulling the same rows adds no duplicates", async () => {
    const rows = [log(100), log(100), log(200)]; // 同 ts 的重复窗口很常见
    const api = makeApi(new Map([[undefined, { logs: rows, next_cursor: null }]]));

    await syncLogsOnce(api, db);
    const second = await syncLogsOnce(api, db);
    expect(await db.logs.count()).toBe(3);
    expect(second.inserted).toBe(0);
  });

  it("increments from the local max ts on subsequent syncs", async () => {
    const existing = [log(100), log(500)];
    await db.logs.bulkPut(existing);
    // 服务端行 id 稳定：ts=500 的行已在库中，会被幂等覆盖而非重复插入。
    const refreshed = { ...existing[1]!, prompt_tokens: 99 };
    const fresh = [refreshed, log(900)];
    const api = makeApi(new Map([[undefined, { logs: fresh, next_cursor: null }]]));

    const result = await syncLogsOnce(api, db);
    expect(api.calls[0]!.from).toBe("500");
    expect(result.inserted).toBe(1);
    expect(await db.logs.count()).toBe(3);
    const updated = await db.logs.get(existing[1]!.id);
    expect(updated?.prompt_tokens).toBe(99);
  });

  it("resumes from the stored cursor when a previous sync was truncated", async () => {
    // 第一次同步：始终有下一页 → 达到上限后截断（用小上限模拟不了，改为直接预置游标场景）：
    // 直接预置 meta.resumeCursor，模拟上次被截断的状态。
    await db.logs.bulkPut([log(900)]);
    await db.setMeta("resumeCursor", "500:abc");

    const backlog = { logs: [log(100), log(300)], next_cursor: null };
    const api = makeApi(new Map<string | undefined, LogsPage>([["500:abc", backlog]]));

    const result = await syncLogsOnce(api, db);
    // 续拉时不带 from（拉历史积压），从游标起翻页。
    expect(api.calls[0]!.from).toBeUndefined();
    expect(api.calls[0]!.cursor).toBe("500:abc");
    expect(result.inserted).toBe(2);
    expect(result.truncated).toBe(false);
    // 拉完积压后游标被清空。
    expect(await db.getMeta<string | null>("resumeCursor")).toBeNull();
    expect(await db.logs.count()).toBe(3);
  });

  it("records the last sync time in meta", async () => {
    const api = makeApi(new Map([[undefined, { logs: [], next_cursor: null }]]));
    await syncLogsOnce(api, db);
    const last = await db.getMeta<number>("lastSyncAt");
    expect(typeof last).toBe("number");
  });
});
