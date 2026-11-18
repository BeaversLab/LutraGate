import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Fetcher, LogSink } from "@lutragate/core";
import { createHandler, type HandlerDeps } from "./index";
import { handleAdmin } from "@lutragate/core";
import { D1AdminDb } from "./d1";
import { D1LogSink } from "./log-sink";
import { extractUsage, injectStreamOptions, SseUsageScanner } from "@lutragate/core";
import migrationSql from "../migrations/0001_init.sql?raw";
import migration2Sql from "../migrations/0002_provider_type.sql?raw";
import migration3Sql from "../migrations/0003_provider_endpoints.sql?raw";
import migration4Sql from "../migrations/0004_users_management_tokens.sql?raw";
import migration5Sql from "../migrations/0005_access_keys_grants.sql?raw";
import migration6Sql from "../migrations/0006_request_log_attribution.sql?raw";
import migration7Sql from "../migrations/0007_quota_limits.sql?raw";
import migration8Sql from "../migrations/0008_access_control.sql?raw";
import migration9Sql from "../migrations/0009_management_credentials.sql?raw";
import migration10Sql from "../migrations/0010_credentials_to_key.sql?raw";
import migration11Sql from "../migrations/0011_log_key_index.sql?raw";
import migration12Sql from "../migrations/0012_log_error_message.sql?raw";

const TEST_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PLAINTEXT_KEY = "sk-live-plaintext-secret";
const T0 = 1_731_024_000_000;
// 数据面身份（multi-user 04）：日志归属两列的目标值。
const LGK = "lgk_logging-test-key-0001";
const UID = "V1StGXR8_Z5jdHi6B-us1";
const AKID = "V1StGXR8_Z5jdHi6B-ak1";

function db(): D1Database {
  if (!env.DB) throw new Error("D1 binding DB missing");
  return env.DB;
}

const WORKER_ENV = {
  DB: env.DB,
  ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  ADMIN_TOKEN: "admin-secret",
};

// Two providers so failover stays deterministic with rng → 0.
const PID_A = "V1StGXR8_Z5jdHi6B-myA";
const PID_B = "V1StGXR8_Z5jdHi6B-myB";
const KID_A1 = "V1StGXR8_Z5jdHi6B-myC";
const KID_B1 = "V1StGXR8_Z5jdHi6B-myE";

async function seedConfig(): Promise<void> {
  const { encryptApiKey, importEncryptionKey, sha256Hex } = await import("@lutragate/core");
  const cryptoKey = await importEncryptionKey(TEST_ENCRYPTION_KEY);
  const encrypted = await encryptApiKey(cryptoKey, PLAINTEXT_KEY);
  await db().batch([
    db().prepare("INSERT INTO provider (id, name, type, enabled, weight, created_at, updated_at) VALUES (?, 'p-a', 'custom', 1, 1, ?, ?)").bind(PID_A, T0, T0),
    db().prepare("INSERT INTO provider (id, name, type, enabled, weight, created_at, updated_at) VALUES (?, 'p-b', 'custom', 1, 1, ?, ?)").bind(PID_B, T0, T0),
    db().prepare("INSERT INTO provider_endpoint (id, provider_id, protocol, base_url) VALUES ('ep-a', ?, 'openai', 'https://a.test')").bind(PID_A),
    db().prepare("INSERT INTO provider_endpoint (id, provider_id, protocol, base_url) VALUES ('ep-b', ?, 'openai', 'https://b.test')").bind(PID_B),
    db().prepare("INSERT INTO provider_key (id, provider_id, encrypted_key, key_hint, enabled, cooldown_until, failure_count, created_at, updated_at) VALUES (?, ?, ?, 'cret', 1, 0, 0, ?, ?)").bind(KID_A1, PID_A, encrypted, T0, T0),
    db().prepare("INSERT INTO provider_key (id, provider_id, encrypted_key, key_hint, enabled, cooldown_until, failure_count, created_at, updated_at) VALUES (?, ?, ?, 'cret', 1, 0, 0, ?, ?)").bind(KID_B1, PID_B, encrypted, T0, T0),
    db().prepare("INSERT INTO model_mapping (id, client_model, provider_id, upstream_model, enabled) VALUES ('V1StGXR8_Z5jdHi6B-myF', 'm1', ?, 'a-up', 1)").bind(PID_A),
    db().prepare("INSERT INTO model_mapping (id, client_model, provider_id, upstream_model, enabled) VALUES ('V1StGXR8_Z5jdHi6B-myG', 'm1', ?, 'b-up', 1)").bind(PID_B),
    // 多用户身份（在 provider_key 之后，满足外键顺序）。
    db().prepare("INSERT INTO user (id, name, role, enabled, created_at, updated_at) VALUES (?, 'alice', 'user', 1, ?, ?)").bind(UID, T0, T0),
    db().prepare("INSERT INTO access_key (id, user_id, name, key_hash, key_hint, enabled, created_at, updated_at) VALUES (?, ?, 'seed', ?, ?, 1, ?, ?)").bind(AKID, UID, await sha256Hex(LGK), LGK.slice(-4), T0, T0),
    db().prepare("INSERT INTO user_key_grant (id, user_id, provider_key_id, created_at) VALUES ('V1StGXR8_Z5jdHi6B-gr1', ?, ?, ?)").bind(UID, KID_A1, T0),
    db().prepare("INSERT INTO user_key_grant (id, user_id, provider_key_id, created_at) VALUES ('V1StGXR8_Z5jdHi6B-gr2', ?, ?, ?)").bind(UID, KID_B1, T0),
  ]);
}

function mockFetcher(outcomes: Response[]): Fetcher & { requests: Request[] } {
  const requests: Request[] = [];
  let call = 0;
  return {
    requests,
    async fetch(req: Request): Promise<Response> {
      requests.push(req.clone());
      return outcomes[Math.min(call++, outcomes.length - 1)] as Response;
    },
  };
}

const okBody = JSON.stringify({
  choices: [],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
});

/**
 * Sink wrapper that records write promises so tests can deterministically
 * await fire-and-forget log writes (no sleeps, no isolated-storage races).
 */
function trackedSink(sink?: LogSink): { sink: LogSink; flush: () => Promise<void> } {
  if (sink) return { sink, flush: async () => undefined };
  // Inject the test clock: the retention cutoff must stay below T0 or the
  // just-written rows (ts = T0, "fourteen days old" vs real time) are
  // immediately reaped.
  const inner = new D1LogSink(db(), { now: () => T0 });
  const pending: Promise<void>[] = [];
  return {
    sink: {
      write(entry) {
        const p = inner.write(entry);
        pending.push(p);
        return p;
      },
    },
    flush: () => Promise.all(pending).then(() => undefined),
  };
}

let currentFlush: () => Promise<void> = async () => undefined;

async function proxy(body: unknown, fetcher: Fetcher, extraDeps: Partial<HandlerDeps> = {}): Promise<Response> {
  const tracked = trackedSink(extraDeps.logSink);
  currentFlush = tracked.flush;
  const handler = createHandler({
    fetcher,
    clock: { now: () => T0 },
    rng: () => 0,
    ...extraDeps,
    logSink: tracked.sink,
  });
  const resp = await handler(
    new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${LGK}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    WORKER_ENV,
  );
  // Non-streaming logs are written before the response returns.
  await currentFlush();
  return resp;
}

/** Consume a streamed response fully, then await the flush-side log write. */
async function drain(resp: Response): Promise<string> {
  const text = await resp.text();
  await currentFlush();
  return text;
}

async function logs(): Promise<Array<Record<string, unknown>>> {
  const { results } = await db().prepare("SELECT * FROM request_log ORDER BY ts, rowid").all<Record<string, unknown>>();
  return results ?? [];
}

beforeAll(async () => {
  const statements = [migrationSql, migration2Sql, migration3Sql, migration4Sql, migration5Sql, migration6Sql, migration7Sql, migration8Sql, migration9Sql, migration10Sql, migration11Sql, migration12Sql].join(";").split(";").map((s) => s.trim()).filter(Boolean);
  await db().batch(statements.map((s) => db().prepare(s)));
});

beforeEach(async () => {
  await db().batch([
    db().prepare("DELETE FROM request_log"),
    db().prepare("DELETE FROM admin_audit"),
    db().prepare("DELETE FROM user_key_grant"),
    db().prepare("DELETE FROM access_key"),
    db().prepare("DELETE FROM management_token"),
    db().prepare("DELETE FROM user"),
    db().prepare("DELETE FROM model_mapping"),
    db().prepare("DELETE FROM provider_key"),
    db().prepare("DELETE FROM provider"),
  ]);
});

describe("usage helpers", () => {
  it("extracts usage from response JSON", () => {
    expect(extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 2 } })).toEqual({
      prompt_tokens: 1,
      completion_tokens: 2,
    });
    expect(extractUsage({})).toBeUndefined();
    expect(extractUsage({ usage: null })).toBeUndefined();
  });

  it("injects stream_options.include_usage only for streaming requests", () => {
    expect(injectStreamOptions({ model: "m", stream: true })).toMatchObject({
      stream_options: { include_usage: true },
    });
    expect(injectStreamOptions({ model: "m", stream: false }).stream_options).toBeUndefined();
    expect(injectStreamOptions({ model: "m" }).stream_options).toBeUndefined();
    // existing flags preserved
    expect(injectStreamOptions({ model: "m", stream: true, stream_options: { foo: 1 } })).toMatchObject({
      stream_options: { foo: 1, include_usage: true },
    });
  });

  it("scans SSE chunks incrementally and tolerates splits/malformed lines", () => {
    const scanner = new SseUsageScanner();
    scanner.push('data: {"choices":[]}\n\nda');
    scanner.push('ta: {"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
    expect(scanner.usage()).toEqual({ prompt_tokens: 3, completion_tokens: 4 });

    const broken = new SseUsageScanner();
    broken.push("data: {not json\n\ndata: [DONE]\n\n");
    expect(broken.usage()).toBeUndefined();
  });
});

describe("proxy request logging", () => {
  it("logs a successful non-streaming request with full fields", async () => {
    await seedConfig();
    const fetcher = mockFetcher([new Response(okBody, { status: 200, headers: { "content-type": "application/json" } })]);
    const resp = await proxy({ model: "m1", messages: [] }, fetcher);
    expect(resp.status).toBe(200);

    const rows = await logs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      client_model: "m1",
      upstream_model: "a-up",
      provider_id: PID_A,
      key_id: KID_A1,
      // 归属（multi-user 04）：成功路径写入 user_id 与 access_key_id。
      user_id: UID,
      access_key_id: AKID,
      prompt_tokens: 11,
      completion_tokens: 7,
      status: 200,
      latency_ms: 0,
      error_type: null,
    });
    expect(typeof rows[0]!.request_id).toBe("string");
  });

  it("logs a streaming request with usage from the final SSE chunk and injects stream_options upstream", async () => {
    await seedConfig();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":6}}\n\n',
      "data: [DONE]\n\n",
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    });
    const fetcher = mockFetcher([new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const resp = await proxy({ model: "m1", stream: true, messages: [] }, fetcher);
    expect(resp.status).toBe(200);
    await drain(resp);

    const upstreamBody = (await fetcher.requests[0]!.json()) as { stream_options?: unknown };
    expect(upstreamBody.stream_options).toEqual({ include_usage: true });

    const rows = await logs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 200,
      provider_id: PID_A,
      prompt_tokens: 5,
      completion_tokens: 6,
    });
  });

  it("tolerates a streaming response without any usage chunk", async () => {
    await seedConfig();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
        c.close();
      },
    });
    const fetcher = mockFetcher([new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const resp = await proxy({ model: "m1", stream: true }, fetcher);
    expect(resp.status).toBe(200);
    await drain(resp);
    const rows = await logs();
    expect(rows[0]).toMatchObject({ status: 200, prompt_tokens: null, completion_tokens: null });
  });

  it("logs exhausted retries as UPSTREAM_ERROR with status 502", async () => {
    await seedConfig();
    const fetcher = mockFetcher([new Response("boom", { status: 500 })]);
    const resp = await proxy({ model: "m1" }, fetcher);
    expect(resp.status).toBe(502);
    const rows = await logs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 502, error_type: "UPSTREAM_ERROR", provider_id: PID_A });
    // 错误详情（打磨轮 B）：合成 502 的 body 解出 last error 摘要。
    expect(String(rows[0]!.error_message)).toContain("last error");
  });

  it("captures the upstream 4xx passthrough body as the error message", async () => {
    await seedConfig();
    // 非 429 4xx 原样透传不重试（spec §3.2）——最常见的 401/429 详情就在其中。
    const fetcher = mockFetcher([
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }),
    ]);
    const resp = await proxy({ model: "m1" }, fetcher);
    expect(resp.status).toBe(401);
    const rows = await logs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 401, error_type: null });
    expect(String(rows[0]!.error_message)).toContain("invalid api key");
  });

  it("logs the cooldown path as NO_CHANNEL:ALL_COOLDOWN with status 503", async () => {
    await seedConfig();
    // Remove provider B so the single key cooling down exhausts channels.
    await db().prepare("DELETE FROM provider WHERE id = ?").bind(PID_B).run();
    const fetcher = mockFetcher([new Response("x", { status: 500 })]);
    const { InMemoryKeyState } = await import("@lutragate/core");
    const resp = await proxy({ model: "m1" }, fetcher, { keyState: new InMemoryKeyState({ threshold: 1 }) });
    expect(resp.status).toBe(503);
    const rows = await logs();
    expect(rows).toHaveLength(1);
    // 错误路径同样写入归属两列；错误详情 = NO_CHANNEL 的原因消息。
    expect(rows[0]).toMatchObject({ status: 503, error_type: "NO_CHANNEL:ALL_COOLDOWN", user_id: UID, access_key_id: AKID });
    expect(typeof rows[0]!.error_message).toBe("string");
    expect(String(rows[0]!.error_message).length).toBeGreaterThan(0);
  });

  it("logs STREAM_ABORTED when the upstream stream errors mid-flight", async () => {
    await seedConfig();
    const brokenStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
        c.error(new Error("upstream pipe broke"));
      },
    });
    const fetcher = mockFetcher([new Response(brokenStream, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const resp = await proxy({ model: "m1", stream: true }, fetcher);
    await expect(resp.text()).rejects.toThrow();
    await currentFlush();
    const rows = await logs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 200, error_type: "STREAM_ABORTED" });
  });

  it("tracks log writes through ctx.waitUntil when provided", async () => {
    await seedConfig();
    const fetcher = mockFetcher([new Response(okBody, { status: 200 })]);
    const trackedByCtx: unknown[] = [];
    let wrote = 0;
    const handler = createHandler({
      fetcher,
      clock: { now: () => T0 },
      rng: () => 0,
      logSink: {
        write() {
          wrote++;
          return Promise.resolve();
        },
      },
    });
    const fakeCtx = {
      waitUntil(p: unknown) {
        trackedByCtx.push(p);
      },
      passThroughOnException() {},
      props: {},
    };
    const resp = await handler(
      new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${LGK}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "m1" }),
      }),
      WORKER_ENV,
      fakeCtx as unknown as ExecutionContext,
    );
    expect(resp.status).toBe(200);
    expect(wrote).toBe(1);
    expect(trackedByCtx).toHaveLength(1);
  });

  it("returns the response normally when the log sink throws", async () => {
    await seedConfig();
    const throwingSink: LogSink = {
      write(): void {
        throw new Error("sink exploded");
      },
    };
    const fetcher = mockFetcher([new Response(okBody, { status: 200 })]);
    const resp = await proxy({ model: "m1" }, fetcher, { logSink: throwingSink });
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ usage: { prompt_tokens: 11 } });
  });
});

describe("GET /admin/logs", () => {
  async function seedLogs(n: number, ts: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      // Descending ids so ordering assertions are deterministic.
      const id = `V1StGXR8_Z5jdHi6B-m${String.fromCharCode(97 + i)}X`.slice(0, 21).padEnd(21, "Z");
      ids.push(id);
      await db()
        .prepare("INSERT INTO request_log (id, request_id, ts, client_model, upstream_model, provider_id, key_id, prompt_tokens, completion_tokens, latency_ms, status, error_type) VALUES (?, ?, ?, 'm1', 'a-up', ?, ?, 1, 1, 5, 200, NULL)")
        .bind(id, `req-${i}`, ts, PID_A, KID_A1)
        .run();
    }
    return ids;
  }

  async function getLogs(query: string): Promise<{ logs: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const resp = await handleAdmin(
      new Request(`http://gw/admin/logs${query}`, { headers: { "x-admin-token": "admin-secret" } }),
      { db: new D1AdminDb(db()), credentials: { adminToken: "admin-secret" } },
    );
    expect(resp.status).toBe(200);
    return resp.json();
  }

  it("paginates with a keyset cursor — no duplicates, no gaps", async () => {
    const ids = await seedLogs(25, T0);
    // Order: ts DESC, id DESC — reverse insertion order.
    const expected = [...ids].sort((a, b) => (a > b ? -1 : 1));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = await getLogs(query);
      seen.push(...body.logs.map((l) => l.id as string));
      cursor = body.next_cursor;
      pages++;
    } while (cursor !== null && pages < 10);
    expect(cursor).toBeNull();
    expect(pages).toBe(3); // 25 rows / 10 per page
    expect(seen).toEqual(expected); // exactly once each
  });

  it("filters by model, provider and time range", async () => {
    await seedLogs(3, T0);
    await db().prepare("INSERT INTO request_log (id, request_id, ts, client_model, upstream_model, provider_id, key_id, latency_ms, status) VALUES ('V1StGXR8_Z5jdHi6B-zz1', 'r', ?, 'm2', NULL, ?, NULL, 1, 200)").bind(T0 + 1000, PID_B).run();

    const byModel = await getLogs("?model=m2");
    expect(byModel.logs).toHaveLength(1);
    expect(byModel.logs[0]).toMatchObject({ client_model: "m2", provider_id: PID_B });

    const byProvider = await getLogs(`?provider=${PID_A}`);
    expect(byProvider.logs).toHaveLength(3);

    const byTime = await getLogs(`?from=${T0 + 1}&to=${T0 + 2000}`);
    expect(byTime.logs).toHaveLength(1);

    const none = await getLogs(`?model=nope`);
    expect(none.logs).toHaveLength(0);
    expect(none.next_cursor).toBeNull();
  });

  it("rejects malformed cursors and non-numeric from/to", async () => {
    const badCursor = await handleAdmin(
      new Request("http://gw/admin/logs?cursor=garbage", { headers: { "x-admin-token": "admin-secret" } }),
      { db: new D1AdminDb(db()), credentials: { adminToken: "admin-secret" } },
    );
    expect(badCursor.status).toBe(400);

    const badFrom = await handleAdmin(
      new Request("http://gw/admin/logs?from=whenever", { headers: { "x-admin-token": "admin-secret" } }),
      { db: new D1AdminDb(db()), credentials: { adminToken: "admin-secret" } },
    );
    expect(badFrom.status).toBe(400);

    const badTo = await handleAdmin(
      new Request("http://gw/admin/logs?to=soon", { headers: { "x-admin-token": "admin-secret" } }),
      { db: new D1AdminDb(db()), credentials: { adminToken: "admin-secret" } },
    );
    expect(badTo.status).toBe(400);

    const clamped = await getLogs("?limit=1000");
    expect(clamped.logs.length).toBeLessThanOrEqual(100);
  });
});
