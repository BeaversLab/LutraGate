import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  dayWindowStart,
  encryptApiKey,
  importEncryptionKey,
  InMemoryKeyState,
  QuotaLedger,
  REQUEST_LOG_INSERT_SQL,
  requestLogParams,
  sha256Hex,
  SqlConfigStore,
  type AdminDb,
  type Fetcher,
  type LogSink,
} from "@lutragate/core";
import { D1AdminDb } from "./d1";
import { createHandler, type HandlerDeps } from "./index";
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
import migration13Sql from "../migrations/0013_log_cached_tokens.sql?raw";

// 网关准入（quota 02）：三级限额 + 并发上限在完整 handler + D1 上的行为。
// 口径：请求数受理即计（含失败路径）；token 软墙（准入按已累计量判断，
// 完成后记账）；failover 中途尝试不消耗额度，额度记最终成功渠道。

const TEST_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PLAINTEXT_KEY = "sk-live-plaintext-secret";
const DAY = 86_400_000;
// 固定在某个白天的时刻，跨午夜测试向前翻一天。
const T0 = new Date("2026-11-09T12:00:00").getTime();

const LGK = "lgk_quota-test-access-key";
const UID = "V1StGXR8_Z5jdHi6B-us1";
const AKID = "V1StGXR8_Z5jdHi6B-ak1";
const PID_A = "V1StGXR8_Z5jdHi6B-pA1";
const PID_B = "V1StGXR8_Z5jdHi6B-pB1";
const PK_A = "V1StGXR8_Z5jdHi6B-kA1";
const PK_B = "V1StGXR8_Z5jdHi6B-kB1";

function db(): D1Database {
  if (!env.DB) throw new Error("D1 binding DB missing");
  return env.DB;
}

let now = T0;
/** 同一账本贯穿一个用例内的所有 handler（真实世界 = 同一 isolate）。 */
let ledger: QuotaLedger;

/** 测试写日志：收集 promise 供 flush，确保播种读到已落库的行。 */
const logWrites: Promise<unknown>[] = [];
const logSink: LogSink = {
  write(entry) {
    const p = db().prepare(REQUEST_LOG_INSERT_SQL).bind(...requestLogParams(entry)).run();
    logWrites.push(p);
    return p as unknown as Promise<void>;
  },
};
const flushLogs = async () => {
  await Promise.all(logWrites);
  logWrites.length = 0;
};

function okResponse(usage = { prompt_tokens: 3, completion_tokens: 4 }): Response {
  return new Response(JSON.stringify({ ok: true, usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 单通道路由种子（A）；withB 时再加 B 通道（failover 用）。 */
async function seed(withB = false): Promise<void> {
  const encrypted = await encryptApiKey(await importEncryptionKey(TEST_ENCRYPTION_KEY), PLAINTEXT_KEY);
  const stmts: D1PreparedStatement[] = [
    db().prepare("INSERT INTO provider (id, name, type, enabled, weight, created_at, updated_at) VALUES (?, 'p-a', 'custom', 1, 1, ?, ?)").bind(PID_A, T0, T0),
    db().prepare("INSERT INTO provider_endpoint (id, provider_id, protocol, base_url) VALUES ('ep-a', ?, 'openai', 'https://a.test')").bind(PID_A),
    db().prepare("INSERT INTO provider_key (id, provider_id, encrypted_key, key_hint, enabled, cooldown_until, failure_count, daily_token_limit, daily_request_limit, created_at, updated_at) VALUES (?, ?, ?, 'cret', 1, 0, 0, 0, 0, ?, ?)").bind(PK_A, PID_A, encrypted, T0, T0),
    db().prepare("INSERT INTO model_mapping (id, client_model, provider_id, upstream_model, enabled) VALUES ('V1StGXR8_Z5jdHi6B-mm1', 'm1', ?, 'a-up', 1)").bind(PID_A),
    db().prepare("INSERT INTO user (id, name, role, enabled, created_at, updated_at) VALUES (?, 'alice', 'user', 1, ?, ?)").bind(UID, T0, T0),
    db().prepare("INSERT INTO access_key (id, user_id, name, key_hash, key_hint, enabled, daily_token_limit, daily_request_limit, max_concurrency, created_at, updated_at) VALUES (?, ?, 'seed', ?, ?, 1, 0, 0, 0, ?, ?)")
      .bind(AKID, UID, await sha256Hex(LGK), LGK.slice(-4), T0, T0),
    db().prepare("INSERT INTO user_key_grant (id, user_id, provider_key_id, daily_token_limit, daily_request_limit, created_at) VALUES ('gr-a', ?, ?, 0, 0, ?)").bind(UID, PK_A, T0),
  ];
  if (withB) {
    stmts.push(
      db().prepare("INSERT INTO provider (id, name, type, enabled, weight, created_at, updated_at) VALUES (?, 'p-b', 'custom', 1, 1, ?, ?)").bind(PID_B, T0, T0),
      db().prepare("INSERT INTO provider_endpoint (id, provider_id, protocol, base_url) VALUES ('ep-b', ?, 'openai', 'https://b.test')").bind(PID_B),
      db().prepare("INSERT INTO provider_key (id, provider_id, encrypted_key, key_hint, enabled, cooldown_until, failure_count, daily_token_limit, daily_request_limit, created_at, updated_at) VALUES (?, ?, ?, 'cret', 1, 0, 0, 0, 0, ?, ?)").bind(PK_B, PID_B, encrypted, T0, T0),
      db().prepare("INSERT INTO model_mapping (id, client_model, provider_id, upstream_model, enabled) VALUES ('V1StGXR8_Z5jdHi6B-mm2', 'm1', ?, 'b-up', 1)").bind(PID_B),
      db().prepare("INSERT INTO user_key_grant (id, user_id, provider_key_id, daily_token_limit, daily_request_limit, created_at) VALUES ('gr-b', ?, ?, 0, 0, ?)").bind(UID, PK_B, T0),
    );
  }
  await db().batch(stmts);
}

async function setLimits(update: {
  access_key?: [number, number, number]; // token, request, concurrency
  grantA?: [number, number];
  grantB?: [number, number];
  providerKeyA?: [number, number];
}): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  if (update.access_key) {
    const [tok, req, conc] = update.access_key;
    stmts.push(db().prepare("UPDATE access_key SET daily_token_limit = ?, daily_request_limit = ?, max_concurrency = ? WHERE id = ?").bind(tok, req, conc, AKID));
  }
  if (update.grantA) {
    stmts.push(db().prepare("UPDATE user_key_grant SET daily_token_limit = ?, daily_request_limit = ? WHERE id = 'gr-a'").bind(...update.grantA));
  }
  if (update.grantB) {
    stmts.push(db().prepare("UPDATE user_key_grant SET daily_token_limit = ?, daily_request_limit = ? WHERE id = 'gr-b'").bind(...update.grantB));
  }
  if (update.providerKeyA) {
    stmts.push(db().prepare("UPDATE provider_key SET daily_token_limit = ?, daily_request_limit = ? WHERE id = ?").bind(...update.providerKeyA, PK_A));
  }
  await db().batch(stmts);
}

/**
 * 新 handler 但共享账本（同一 isolate 语义）；configStore 不走缓存，
 * setLimits 改库后下一请求立刻生效。
 */
function makeHandler(overrides: Partial<HandlerDeps> = {}): ReturnType<typeof createHandler> {
  return createHandler({
    configStore: new SqlConfigStore(new D1AdminDb(db())),
    fetcher: overrides.fetcher ?? { fetch: async () => okResponse() },
    keyState: overrides.keyState ?? new InMemoryKeyState({ threshold: 1 }),
    quota: overrides.quota ?? ledger,
    clock: { now: () => now },
    rng: () => 0,
    logSink,
    ...overrides,
  });
}

function chatReq(body: unknown = { model: "m1", messages: [] }): Request {
  return new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${LGK}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const WORKER_ENV = { DB: env.DB, ENCRYPTION_KEY: TEST_ENCRYPTION_KEY };

async function errorOf(resp: Response): Promise<{ code: string; message: string }> {
  expect(resp.status).toBe(429);
  return ((await resp.json()) as { error: { code: string; message: string } }).error;
}

async function logCount(): Promise<number> {
  const row = await db().prepare("SELECT COUNT(*) AS n FROM request_log").first<{ n: number }>();
  return row!.n;
}

beforeAll(async () => {
  const statements = [migrationSql, migration2Sql, migration3Sql, migration4Sql, migration5Sql, migration6Sql, migration7Sql, migration8Sql, migration9Sql, migration10Sql, migration11Sql, migration12Sql, migration13Sql].join(";").split(";").map((s) => s.trim()).filter(Boolean);
  await db().batch(statements.map((s) => db().prepare(s)));
});

// 悬空 D1 写 promise 跨测试边界会触发 isolated-storage 快照竞争（见
// d1.test.ts 注释）——用例结尾统一冲账。
afterEach(async () => {
  await flushLogs();
});

beforeEach(async () => {
  now = T0;
  ledger = new QuotaLedger({ db: new D1AdminDb(db()), clock: { now: () => now } });
  await db().batch([
    db().prepare("DELETE FROM request_log"),
    db().prepare("DELETE FROM admin_audit"),
    db().prepare("DELETE FROM user_key_grant"),
    db().prepare("DELETE FROM access_key"),
    db().prepare("DELETE FROM user"),
    db().prepare("DELETE FROM model_mapping"),
    db().prepare("DELETE FROM provider_key"),
    db().prepare("DELETE FROM provider_endpoint"),
    db().prepare("DELETE FROM provider"),
  ]);
});

describe("gateway quota admission (quota 02)", () => {
  it("rejects at the access-key request limit with a level+kind message and leaves no log row", async () => {
    await seed();
    await setLimits({ access_key: [0, 1, 0] });
    const handler = makeHandler();

    const first = await handler(chatReq(), WORKER_ENV);
    expect(first.status).toBe(200);
    await flushLogs();
    expect(await logCount()).toBe(1);

    // 第二请求被拒：429 + 级别/种类消息；拒绝不留痕（行数不变）。
    const err = await errorOf(await handler(chatReq(), WORKER_ENV));
    expect(err.code).toBe("RATE_LIMITED_LOCAL");
    expect(err.message).toBe("access key request quota exceeded");
    expect(await logCount()).toBe(1);
  });

  it("treats token limits as a soft wall: one request may overshoot, the next is rejected", async () => {
    await seed();
    await setLimits({ access_key: [1, 0, 0] }); // token 限额 1
    const handler = makeHandler();

    expect((await handler(chatReq(), WORKER_ENV)).status).toBe(200); // 准入时已累计 0 → 放行（记账 7 tokens）
    await flushLogs();
    expect((await errorOf(await handler(chatReq(), WORKER_ENV))).message).toBe("access key token quota exceeded");
  });

  it("enforces grant-level and asset-level limits with their own messages", async () => {
    await seed();

    // 授权级：该次分配的日预算。
    await setLimits({ grantA: [5, 0] });
    expect((await makeHandler()(chatReq(), WORKER_ENV)).status).toBe(200); // 7 tokens 越限记账
    await flushLogs();
    expect((await errorOf(await makeHandler()(chatReq(), WORKER_ENV))).message).toBe("user grant token quota exceeded");

    // 资产级：上游 key 的跨用户总闸。
    await db().batch([db().prepare("DELETE FROM request_log")]);
    await setLimits({ grantA: [0, 0], providerKeyA: [0, 1] });
    expect((await makeHandler()(chatReq(), WORKER_ENV)).status).toBe(200);
    await flushLogs();
    expect((await errorOf(await makeHandler()(chatReq(), WORKER_ENV))).message).toBe("provider key request quota exceeded");
  });

  it("rejects when any of several configured levels is exceeded", async () => {
    await seed();
    await setLimits({ access_key: [0, 1, 0], grantA: [5, 0] });
    const handler = makeHandler();
    expect((await handler(chatReq(), WORKER_ENV)).status).toBe(200);
    await flushLogs();
    // 任一命中即拒：场景级检查在准入先于授权级，消息确定。
    const err = await errorOf(await handler(chatReq(), WORKER_ENV));
    expect(err).toMatchObject({ code: "RATE_LIMITED_LOCAL", message: "access key request quota exceeded" });
  });

  it("counts admitted requests even when the upstream call fails", async () => {
    await seed();
    await setLimits({ access_key: [0, 1, 0] });
    const failing: Fetcher = { fetch: async () => new Response("boom", { status: 500 }) };
    // 默认 threshold=3：三次尝试都落在 A 上（单通道无路可退），502 而非冷却短路。
    const handler = makeHandler({ fetcher: failing, keyState: new InMemoryKeyState() });

    expect((await handler(chatReq(), WORKER_ENV)).status).toBe(502); // 三次尝试全 5xx
    await flushLogs();
    // 受理即计（含失败路径）：第二请求 429。
    expect((await errorOf(await handler(chatReq(), WORKER_ENV))).message).toBe("access key request quota exceeded");
  });

  it("failover attempts consume no quota; only the final successful channel is recorded", async () => {
    await seed(true); // A、B 两通道
    // A 恒 5xx、B 恒成功。授权 A 限 1 请求（失败尝试永不消耗）、授权 B 限 2
    // （成功渠道逐笔记账，播种亦从 request_log 读 B 的成功行）。
    await setLimits({ grantA: [0, 1], grantB: [0, 2] });
    const fetcher: Fetcher = {
      fetch: async (req: Request) =>
        req.url.startsWith("https://a.test")
          ? new Response("boom", { status: 500 })
          : okResponse(),
    };
    const attempt = () => makeHandler({ fetcher }); // 全新 keyState：A 每次都先被选

    // 请求 1、2：A 尝试（授权 A 检查通过即转发失败，不消耗）→ A 冷却 →
    // B 成功记账。若失败尝试也消耗额度，请求 2 的 A 尝试就会 429。
    expect((await attempt()(chatReq(), WORKER_ENV)).status).toBe(200);
    await flushLogs();
    expect((await attempt()(chatReq(), WORKER_ENV)).status).toBe(200);
    await flushLogs();

    // 请求 3：A 检查仍通过（限额 1、用量 0）→ 转发失败 → B 已记 2 笔 ≥ 2 →
    // 429 且消息注明授权级——额度只记最终成功渠道的上游 key。
    const rejected = await errorOf(await attempt()(chatReq(), WORKER_ENV));
    expect(rejected.message).toBe("user grant request quota exceeded");
  });

  it("enforces the access-key concurrency limit and releases the slot after completion", async () => {
    await seed();
    await setLimits({ access_key: [0, 0, 1] }); // 并发上限 1
    // 可挂起的 fetcher：第一请求吊在 gate 上，之后的请求立即成功。
    let gateResolve!: (resp: Response) => void;
    const gate = new Promise<Response>((res) => (gateResolve = res));
    let calls = 0;
    let fetchEntered!: () => void;
    const entered = new Promise<void>((res) => (fetchEntered = res));
    const hanging: Fetcher = {
      fetch: () => {
        calls++;
        fetchEntered();
        return calls === 1 ? gate : Promise.resolve(okResponse());
      },
    };
    const handler = makeHandler({ fetcher: hanging });

    const inFlight = handler(chatReq(), WORKER_ENV);
    // fetch 已被调用 = 第一请求已过准入、占住并发槽。
    await entered;
    expect(calls).toBe(1);

    // 同 key 第二并发 → 429。
    expect((await errorOf(await handler(chatReq(), WORKER_ENV))).message).toBe("access key concurrency limit exceeded");

    // 完成第一请求 → 释放槽 → 可复用。
    gateResolve(okResponse());
    expect((await inFlight).status).toBe(200);
    await flushLogs();
    expect((await handler(chatReq(), WORKER_ENV)).status).toBe(200);
    await flushLogs();
  });

  it("re-seeds into a fresh window after local midnight (clock injection)", async () => {
    await seed();
    await setLimits({ access_key: [0, 1, 0] });
    const handler = makeHandler();
    expect((await handler(chatReq(), WORKER_ENV)).status).toBe(200);
    await flushLogs();
    expect((await errorOf(await handler(chatReq(), WORKER_ENV))).message).toBe("access key request quota exceeded");

    // 跨过本地午夜：新窗口 → 重新播种；旧行 ts < 窗口起点不计入。
    now = dayWindowStart(T0) + DAY + 3_600_000;
    expect((await makeHandler()(chatReq(), WORKER_ENV)).status).toBe(200);
    await flushLogs();
  });

  it("absorbs usage written by other sources after the seed TTL expires", async () => {
    await seed();
    await setLimits({ access_key: [57, 0, 0] });
    const handler = makeHandler();
    expect((await handler(chatReq(), WORKER_ENV)).status).toBe(200); // 记账 7 tokens
    await flushLogs();

    // 他源（其他 isolate / 直接写库）追加 50 tokens。
    await db().prepare(
      "INSERT INTO request_log (id, request_id, ts, client_model, status, user_id, access_key_id, prompt_tokens) VALUES ('ext-1', 'ext', ?, 'm1', 200, ?, ?, 50)",
    ).bind(now, UID, AKID).run();

    // TTL 过期 → 重播种吸收库值（7 + 50 = 57 ≥ 57）→ 拒。
    now += 61_000;
    expect((await errorOf(await makeHandler()(chatReq(), WORKER_ENV))).message).toBe("access key token quota exceeded");
  });

  it("fails open when seeding fails, then enforces on the next request", async () => {
    await seed();
    await setLimits({ access_key: [0, 1, 0] });
    // 库里已有一笔当日用量（播种应读到 1 → 本应拒绝）。
    await db().prepare(
      "INSERT INTO request_log (id, request_id, ts, client_model, status, user_id, access_key_id) VALUES ('pre-1', 'pre', ?, 'm1', 200, ?, ?)",
    ).bind(now, UID, AKID).run();

    // 播种抛错一次：fail-open 放行；不标记已播，下个请求重试/被内存账拒绝。
    const inner: AdminDb = new D1AdminDb(db());
    let failOnce = true;
    const flaky: AdminDb = {
      all<T>(sql: string, params: unknown[]) {
        if (failOnce && sql.includes("FROM request_log")) {
          failOnce = false;
          return Promise.reject(new Error("D1 hiccup"));
        }
        return inner.all<T>(sql, params);
      },
      run: (sql: string, params: unknown[]) => inner.run(sql, params),
    };
    const handler = makeHandler({ quota: new QuotaLedger({ db: flaky, clock: { now: () => now } }) });
    expect((await handler(chatReq(), WORKER_ENV)).status).toBe(200); // fail-open
    await flushLogs();
    expect((await errorOf(await handler(chatReq(), WORKER_ENV))).message).toBe("access key request quota exceeded");
  });

  it("does zero ledger reads for unlimited keys (v1.0 behavior)", async () => {
    await seed(); // 全部 0 = 不限
    const inner: AdminDb = new D1AdminDb(db());
    let reads = 0;
    const counting: AdminDb = {
      all<T>(sql: string, params: unknown[]) {
        reads++;
        return inner.all<T>(sql, params);
      },
      run: (sql: string, params: unknown[]) => inner.run(sql, params),
    };
    const handler = makeHandler({ quota: new QuotaLedger({ db: counting, clock: { now: () => now } }) });
    expect((await handler(chatReq(), WORKER_ENV)).status).toBe(200);
    await flushLogs();
    expect((await handler(chatReq(), WORKER_ENV)).status).toBe(200); // 连续多次也不读
    await flushLogs();
    expect(reads).toBe(0);
  });

  it("charges no grant/asset quota when every attempt fails (502)", async () => {
    await seed();
    await setLimits({ grantA: [0, 1] }); // 授权限 1：若全败也记账，第二请求会被拒
    const failing: Fetcher = { fetch: async () => new Response("boom", { status: 500 }) };

    // 全部尝试失败 → 合成 502；无成功渠道 → 授权级不记账。
    const exhausted = makeHandler({ fetcher: failing, keyState: new InMemoryKeyState() });
    expect((await exhausted(chatReq(), WORKER_ENV)).status).toBe(502);
    await flushLogs();

    // 下一请求（成功路径）应仍能通过授权检查。
    expect((await makeHandler()(chatReq(), WORKER_ENV)).status).toBe(200);
    await flushLogs();
  });

  it("releases the concurrency slot when a streaming response aborts", async () => {
    await seed();
    await setLimits({ access_key: [0, 0, 1] });
    // 流先吐一个 chunk 再报错：forwardStreamed 的 onError 路径收尾并发槽。
    const brokenStream = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{}}]}\n\n"));
            controller.error(new Error("upstream stream broke"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const handler = makeHandler({ fetcher: { fetch: async () => brokenStream() } });

    const resp = await handler(chatReq({ model: "m1", stream: true, messages: [] }), WORKER_ENV);
    expect(resp.status).toBe(200);
    await expect(resp.text()).rejects.toThrow(); // 客户端侧看到流中断
    await flushLogs();

    // onError 已释放并发槽：下一请求可进场。
    expect((await makeHandler({ fetcher: { fetch: async () => okResponse() } })(chatReq(), WORKER_ENV)).status).toBe(200);
    await flushLogs();
  });

  it("releases the concurrency slot when a streaming response finishes", async () => {
    await seed();
    await setLimits({ access_key: [0, 0, 1] });
    const sse = () => new Response(
      "data: {\"choices\":[{\"delta\":{}}]}\n\ndata: {\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const handler = makeHandler({ fetcher: { fetch: async () => sse() } });

    const resp = await handler(chatReq({ model: "m1", stream: true, messages: [] }), WORKER_ENV);
    expect(resp.status).toBe(200);
    // 消费完流主体，触发 onFlush（释放并发槽 + 记账）。
    await resp.text();
    await flushLogs();

    // 槽已释放：下一请求可进场。
    expect((await makeHandler({ fetcher: { fetch: async () => okResponse() } })(chatReq(), WORKER_ENV)).status).toBe(200);
    await flushLogs();
  });
});
