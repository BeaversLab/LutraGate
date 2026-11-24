import { beforeAll, beforeEach, afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CachedConfigStore,
  createGatewayHandler,
  dayWindowStart,
  decryptApiKey,
  encryptApiKey,
  handleAdmin,
  importEncryptionKey,
  InMemoryKeyState,
  QuotaLedger,
  sha256Hex,
  type AdminDb,
  type Fetcher,
  type LogSink,
} from "@lutragate/core";
import { SqliteAdminDb, SqlConfigStore, SqliteLogSink, openDb } from "./db";
import { createApp } from "./index";
import { loadEnv, type ServerEnv } from "./env";

// 32-byte zero key in base64 (test only).
const TEST_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PLAINTEXT_KEY = "sk-live-plaintext-secret";
const T0 = 1_731_024_000_000;
// 数据面身份（multi-user 04）：日志归属两列的目标值。
const LGK = "lgk_server-test-key-0001";
const UID = "V1StGXR8_Z5jdHi6B-us1";
const AKID = "V1StGXR8_Z5jdHi6B-ak1";

function env(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    ...loadEnv({
      ADMIN_TOKEN: "admin-secret",
      ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    }),
    dbPath: ":memory:",
    ...overrides,
  };
}

let db: ReturnType<typeof openDb>;
let adminDb: SqliteAdminDb;
let cache: CachedConfigStore;
let logSink: SqliteLogSink;
let srvEnv: ServerEnv;

beforeAll(() => {
  srvEnv = env();
  db = openDb(":memory:");
  adminDb = new SqliteAdminDb(db);
  cache = new CachedConfigStore(new SqlConfigStore(adminDb));
  logSink = new SqliteLogSink(db, { now: () => T0 }); // test clock: retention must not reap T0 rows
});

beforeEach(async () => {
  await adminDb.run("DELETE FROM request_log", []);
  await adminDb.run("DELETE FROM admin_audit", []);
  await adminDb.run("DELETE FROM user_key_grant", []);
  await adminDb.run("DELETE FROM access_key", []);
  await adminDb.run("DELETE FROM management_token", []);
  await adminDb.run("DELETE FROM user", []);
  await adminDb.run("DELETE FROM model_mapping", []);
  await adminDb.run("DELETE FROM provider_key", []);
  await adminDb.run("DELETE FROM provider", []);
});

type UpstreamRequest = Parameters<Fetcher["fetch"]>[0];

function mockFetcher(outcomes: Response[]): Fetcher & { requests: UpstreamRequest[] } {
  const requests: UpstreamRequest[] = [];
  let call = 0;
  return {
    requests,
    async fetch(req: Request): Promise<Response> {
      // Body is left unconsumed so tests can still read it afterwards.
      requests.push(req as UpstreamRequest);
      return outcomes[Math.min(call++, outcomes.length - 1)] as Response;
    },
  } as unknown as Fetcher & { requests: UpstreamRequest[] };
}

let currentFlush: () => Promise<void> = async () => undefined;

async function gateway(
  fetcher: Fetcher,
  body: unknown,
  opts: { clockNow?: () => number; accessKey?: string; clientIp?: (request: Request) => string | null } = {},
): Promise<Response> {
  const pending: Promise<void>[] = [];
  const trackedSink: LogSink = {
    write(entry) {
      const p = logSink.write(entry);
      pending.push(p);
      return p;
    },
  };
  currentFlush = () => Promise.all(pending).then(() => undefined);
  const cryptoKey = await importEncryptionKey(TEST_ENCRYPTION_KEY);
  const handler = createGatewayHandler({
    getConfig: () => cache.getActiveConfig(),
    resolveKey: (key) => decryptApiKey(cryptoKey, key.encrypted_key),
    logSink: trackedSink,
    clientIp: opts.clientIp,
    clock: { now: opts.clockNow ?? (() => T0) },
    rng: () => 0,
    fetcher,
  });
  const resp = await handler(
    new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${opts.accessKey ?? LGK}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  await currentFlush();
  return resp;
}

async function seedConfig(): Promise<void> {
  const cryptoKey = await importEncryptionKey(TEST_ENCRYPTION_KEY);
  const encrypted = await encryptApiKey(cryptoKey, PLAINTEXT_KEY);
  const rows: Array<[string, unknown[]]> = [
    ["INSERT INTO provider (id, name, type, enabled, weight, created_at, updated_at) VALUES (?, 'p-a', 'custom', 1, 1, ?, ?)", ["V1StGXR8_Z5jdHi6B-myA", T0, T0]],
    ["INSERT INTO provider (id, name, type, enabled, weight, created_at, updated_at) VALUES (?, 'p-b', 'custom', 1, 1, ?, ?)", ["V1StGXR8_Z5jdHi6B-myB", T0, T0]],
    ["INSERT INTO provider_endpoint (id, provider_id, protocol, base_url) VALUES ('ep-a', ?, 'openai', 'https://a.test')", ["V1StGXR8_Z5jdHi6B-myA"]],
    ["INSERT INTO provider_endpoint (id, provider_id, protocol, base_url) VALUES ('ep-b', ?, 'openai', 'https://b.test')", ["V1StGXR8_Z5jdHi6B-myB"]],
    ["INSERT INTO provider_key (id, provider_id, encrypted_key, key_hint, enabled, cooldown_until, failure_count, created_at, updated_at) VALUES (?, ?, ?, 'cret', 1, 0, 0, ?, ?)", ["V1StGXR8_Z5jdHi6B-myC", "V1StGXR8_Z5jdHi6B-myA", encrypted, T0, T0]],
    ["INSERT INTO provider_key (id, provider_id, encrypted_key, key_hint, enabled, cooldown_until, failure_count, created_at, updated_at) VALUES (?, ?, ?, 'cret', 1, 0, 0, ?, ?)", ["V1StGXR8_Z5jdHi6B-myE", "V1StGXR8_Z5jdHi6B-myB", encrypted, T0, T0]],
    ["INSERT INTO model_mapping (id, client_model, provider_id, upstream_model, enabled) VALUES ('V1StGXR8_Z5jdHi6B-myF', 'm1', ?, 'a-up', 1)", ["V1StGXR8_Z5jdHi6B-myA"]],
    ["INSERT INTO model_mapping (id, client_model, provider_id, upstream_model, enabled) VALUES ('V1StGXR8_Z5jdHi6B-myG', 'm1', ?, 'b-up', 1)", ["V1StGXR8_Z5jdHi6B-myB"]],
    // 多用户身份：单用户 + 一把 lgk_ + 两把上游 key 的授权（failover 需要）。
    ["INSERT INTO user (id, name, role, enabled, created_at, updated_at) VALUES (?, 'alice', 'user', 1, ?, ?)", [UID, T0, T0]],
    ["INSERT INTO access_key (id, user_id, name, key_hash, key_hint, enabled, created_at, updated_at) VALUES (?, ?, 'seed', ?, ?, 1, ?, ?)", [AKID, UID, await sha256Hex(LGK), LGK.slice(-4), T0, T0]],
    ["INSERT INTO user_key_grant (id, user_id, provider_key_id, created_at) VALUES ('V1StGXR8_Z5jdHi6B-gr1', ?, ?, ?)", [UID, "V1StGXR8_Z5jdHi6B-myC", T0]],
    ["INSERT INTO user_key_grant (id, user_id, provider_key_id, created_at) VALUES ('V1StGXR8_Z5jdHi6B-gr2', ?, ?, ?)", [UID, "V1StGXR8_Z5jdHi6B-myE", T0]],
  ];
  for (const [sql, params] of rows) await adminDb.run(sql, params);
}

async function logs(): Promise<Array<Record<string, unknown>>> {
  return adminDb.all("SELECT * FROM request_log ORDER BY ts, rowid", []);
}

// ---- 旧库升级（multi-user 08 部署时抓到的回归）----------------------------------

describe("sqlite adapter: upgrading a pre-multi-user database", () => {
  it("opens an old-schema database (request_log without attribution columns)", async () => {
    // 造一个只有旧 schema 的库文件：request_log 无 user_id/access_key_id 列。
    const path = `${import.meta.dir}/.tmp-old-schema-test.db`;
    const { rmSync } = await import("node:fs");
    try { rmSync(path); } catch { /* 无残留 */ }
    const { Database } = await import("bun:sqlite");
    const legacy = new Database(path, { create: true });
    legacy.exec("PRAGMA foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE provider (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT, enabled INTEGER NOT NULL DEFAULT 1, weight INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE request_log (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, ts INTEGER NOT NULL, client_model TEXT NOT NULL, upstream_model TEXT, provider_id TEXT, key_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, status INTEGER NOT NULL, error_type TEXT);
      INSERT INTO request_log (id, request_id, ts, client_model, status) VALUES ('legacy-1', 'r', 1, 'm1', 200);
    `);
    legacy.close();

    // openDb 必须先补列（migrate）再建索引（DDL），不抛 no such column。
    const db = openDb(path);
    const columns = db.prepare("PRAGMA table_info(request_log)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain("user_id");
    expect(columns.map((c) => c.name)).toContain("access_key_id");
    // 旧数据保留，新索引已建。
    const rows = db.prepare("SELECT COUNT(*) AS n FROM request_log").all() as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_log_user'").get()).toBeTruthy();
    db.close();
    rmSync(path);
  });

  it("opens a pre-quota database (limit columns missing on three tables)", async () => {
    // 造一个只有 v1.0 schema 的库文件：三表均无限额列。
    const path = `${import.meta.dir}/.tmp-pre-quota-test.db`;
    const { rmSync } = await import("node:fs");
    try { rmSync(path); } catch { /* 无残留 */ }
    const { Database } = await import("bun:sqlite");
    const legacy = new Database(path, { create: true });
    legacy.exec("PRAGMA foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('administrator', 'user')), enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE provider (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'custom', enabled INTEGER NOT NULL DEFAULT 1, weight INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE provider_key (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE, encrypted_key TEXT NOT NULL, key_hint TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, cooldown_until INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE access_key (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_hint TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE user_key_grant (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, provider_key_id TEXT NOT NULL REFERENCES provider_key(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, UNIQUE(user_id, provider_key_id));
      INSERT INTO user (id, name, role, enabled, created_at, updated_at) VALUES ('legacy-user', 'legacy', 'user', 1, 1, 1);
      INSERT INTO provider (id, name, type, enabled, weight, created_at, updated_at) VALUES ('legacy-prov', 'p', 'custom', 1, 1, 1, 1);
      INSERT INTO provider_key (id, provider_id, encrypted_key, key_hint, enabled, cooldown_until, failure_count, created_at, updated_at) VALUES ('legacy-pk', 'legacy-prov', 'enc', 'hint', 1, 0, 0, 1, 1);
      INSERT INTO access_key (id, user_id, name, key_hash, key_hint, enabled, created_at, updated_at) VALUES ('legacy-ak', 'legacy-user', 'k', 'hash', 'hint', 1, 1, 1);
      INSERT INTO user_key_grant (id, user_id, provider_key_id, created_at) VALUES ('legacy-gr', 'legacy-user', 'legacy-pk', 1);
    `);
    legacy.close();

    // openDb 补齐三处限额列，旧行落默认 0（不限），数据保留。
    const db = openDb(path);
    const expected: Array<[string, string]> = [
      ["access_key", "daily_token_limit"], ["access_key", "daily_request_limit"], ["access_key", "max_concurrency"],
      ["user_key_grant", "daily_token_limit"], ["user_key_grant", "daily_request_limit"],
      ["provider_key", "daily_token_limit"], ["provider_key", "daily_request_limit"],
    ];
    for (const [table, column] of expected) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain(column);
    }
    const ak = db.prepare("SELECT daily_token_limit, daily_request_limit, max_concurrency FROM access_key WHERE id = 'legacy-ak'").get() as Record<string, number>;
    expect(ak).toEqual({ daily_token_limit: 0, daily_request_limit: 0, max_concurrency: 0 });
    const grants = db.prepare("SELECT COUNT(*) AS n FROM user_key_grant").all() as Array<{ n: number }>;
    expect(grants[0]!.n).toBe(1);
    db.close();
    rmSync(path);
  });

  it("opens a pre-access-control database (six v1.2 columns missing)", async () => {
    // 造一个只有 v1.1（quota 后）schema 的库文件：三表均无访问控制列。
    const path = `${import.meta.dir}/.tmp-pre-access-control-test.db`;
    const { rmSync } = await import("node:fs");
    try { rmSync(path); } catch { /* 无残留 */ }
    const { Database } = await import("bun:sqlite");
    const legacy = new Database(path, { create: true });
    legacy.exec("PRAGMA foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('administrator', 'user')), enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE management_token (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, key_hint TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE provider (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'custom', enabled INTEGER NOT NULL DEFAULT 1, weight INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE access_key (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_hint TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, daily_token_limit INTEGER NOT NULL DEFAULT 0, daily_request_limit INTEGER NOT NULL DEFAULT 0, max_concurrency INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO user (id, name, role, enabled, created_at, updated_at) VALUES ('legacy-user', 'legacy', 'user', 1, 1, 1);
      INSERT INTO management_token (id, user_id, token_hash, key_hint, enabled, created_at, updated_at) VALUES ('legacy-mt', 'legacy-user', '${"h".repeat(64)}', 'lgm_', 1, 1, 1);
      INSERT INTO provider (id, name, type, enabled, weight, created_at, updated_at) VALUES ('legacy-prov', 'p', 'custom', 1, 1, 1, 1);
      INSERT INTO access_key (id, user_id, name, key_hash, key_hint, enabled, created_at, updated_at) VALUES ('legacy-ak', 'legacy-user', 'k', 'hash', 'hint', 1, 1, 1);
    `);
    legacy.close();

    // openDb 补齐六列，旧行落默认（0 / '[]'），数据保留。
    const db = openDb(path);
    const expected: Array<[string, string]> = [
      ["access_key", "expires_at"], ["access_key", "ip_allowlist"],
      ["management_token", "expires_at"], ["management_token", "last_used_at"],
      ["provider", "cooldown_failure_threshold"], ["provider", "cooldown_ms"],
    ];
    for (const [table, column] of expected) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain(column);
    }
    const ak = db.prepare("SELECT expires_at, ip_allowlist FROM access_key WHERE id = 'legacy-ak'").get() as Record<string, unknown>;
    expect(ak).toEqual({ expires_at: 0, ip_allowlist: "[]" });
    const mt = db.prepare("SELECT expires_at, last_used_at FROM management_token WHERE id = 'legacy-mt'").get() as Record<string, number>;
    expect(mt).toEqual({ expires_at: 0, last_used_at: 0 });
    const prov = db.prepare("SELECT cooldown_failure_threshold, cooldown_ms FROM provider WHERE id = 'legacy-prov'").get() as Record<string, number>;
    expect(prov).toEqual({ cooldown_failure_threshold: 0, cooldown_ms: 0 });
    db.close();
    rmSync(path);
  });

  it("opens a 02-era database (credentials migrate from provider to provider_key)", async () => {
    // 造一个 0009 时代的库：provider 带管控面凭证列、provider_key 没带。
    const path = `${import.meta.dir}/.tmp-pre-usage-test.db`;
    const { rmSync } = await import("node:fs");
    try { rmSync(path); } catch { /* 无残留 */ }
    const { Database } = await import("bun:sqlite");
    const legacy = new Database(path, { create: true });
    legacy.exec("PRAGMA foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE provider (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'custom', enabled INTEGER NOT NULL DEFAULT 1, weight INTEGER NOT NULL DEFAULT 1, cooldown_failure_threshold INTEGER NOT NULL DEFAULT 0, cooldown_ms INTEGER NOT NULL DEFAULT 0, management_credentials TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE provider_key (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE, encrypted_key TEXT NOT NULL, key_hint TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, cooldown_until INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0, daily_token_limit INTEGER NOT NULL DEFAULT 0, daily_request_limit INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO provider (id, name, type, enabled, weight, created_at, updated_at) VALUES ('legacy-prov', 'p', 'custom', 1, 1, 1, 1);
      INSERT INTO provider_key (id, provider_id, encrypted_key, key_hint, enabled, cooldown_until, failure_count, daily_token_limit, daily_request_limit, created_at, updated_at) VALUES ('legacy-pk', 'legacy-prov', 'enc', 'hint', 1, 0, 0, 0, 0, 1, 1);
    `);
    legacy.close();

    // openDb：provider_key 补列（可空 NULL）；provider 删列（0009 引入，04 下沉，
    // 生产无数据已核）。两个方向都成立——全新库（provider 无列）DROP 走防御分支。
    const db = openDb(path);
    const keyCols = db.prepare("PRAGMA table_info(provider_key)").all() as Array<{ name: string }>;
    expect(keyCols.map((c) => c.name)).toContain("management_credentials");
    const provCols = db.prepare("PRAGMA table_info(provider)").all() as Array<{ name: string }>;
    expect(provCols.map((c) => c.name)).not.toContain("management_credentials");
    const pk = db.prepare("SELECT management_credentials FROM provider_key WHERE id = 'legacy-pk'").get() as Record<string, unknown>;
    expect(pk).toEqual({ management_credentials: null });
    db.close();
    rmSync(path);
  });
});

describe("sqlite adapter: config store", () => {
  it("maps rows onto GatewayConfig with booleans", async () => {
    await seedConfig();
    const config = await new SqlConfigStore(adminDb).getActiveConfig();
    expect(config.providers.length).toBe(2);
    expect(config.providers[0]!.enabled).toBe(true);
    expect(config.keys.length).toBe(2);
    expect(config.keys[0]!.key_hint).toBe("cret");
    expect(config.mappings.length).toBe(2);
  });
});

describe("sqlite adapter: proxy paths (shared gateway handler)", () => {
  it("decrypts the key and proxies a non-streaming request", async () => {
    await seedConfig();
    const fetcher = mockFetcher([
      new Response(JSON.stringify({ ok: true, usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const resp = await gateway(fetcher, { model: "m1", messages: [] });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { usage: { prompt_tokens: number } };
    expect(body.usage.prompt_tokens).toBe(3);
    expect(fetcher.requests[0]!.headers.get("authorization")).toBe(`Bearer ${PLAINTEXT_KEY}`);
    expect(fetcher.requests[0]!.url).toBe("https://a.test/v1/chat/completions");

    const rows = await logs();
    expect(rows.length).toBe(1);
    expect(rows[0]!).toMatchObject({
      client_model: "m1", upstream_model: "a-up", status: 200,
      // 归属（multi-user 04）：user_id 与 access_key_id 落日志。
      user_id: UID, access_key_id: AKID,
      prompt_tokens: 3, completion_tokens: 4,
    });
  });

  it("streams SSE responses and extracts usage from the final chunk", async () => {
    await seedConfig();
    const chunks = [
      'data: {"choices":[]}\n\n',
      'data: {"usage":{"prompt_tokens":9,"completion_tokens":8}}\n\n',
      "data: [DONE]\n\n",
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    });
    const fetcher = mockFetcher([new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })]);
    const resp = await gateway(fetcher, { model: "m1", stream: true });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    await currentFlush();
    expect(text).toBe(chunks.join(""));
    const rows = await logs();
    expect(rows[0]!).toMatchObject({ status: 200, prompt_tokens: 9, completion_tokens: 8 });
  });

  it("switches channels on 5xx and logs the failure path", async () => {
    await seedConfig();
    const fetcher = mockFetcher([
      new Response("boom", { status: 500 }),
      new Response("{}", { status: 200 }),
    ]);
    // threshold 1 → provider A cools down → retry lands on B.
    const { InMemoryKeyState } = await import("@lutragate/core");
    const resp = await gatewayWithKeyState(fetcher, { model: "m1" }, new InMemoryKeyState({ threshold: 1 }));
    expect(resp.status).toBe(200);
    expect(fetcher.requests.map((r) => r.url)).toEqual([
      "https://a.test/v1/chat/completions",
      "https://b.test/v1/chat/completions",
    ]);
  });

  async function gatewayWithKeyState(fetcher: Fetcher, body: unknown, keyState: InstanceType<typeof import("@lutragate/core").InMemoryKeyState>): Promise<Response> {
    const cryptoKey = await importEncryptionKey(TEST_ENCRYPTION_KEY);
    const handler = createGatewayHandler({
      getConfig: () => cache.getActiveConfig(),
      resolveKey: (key) => decryptApiKey(cryptoKey, key.encrypted_key),
      logSink,
      clock: { now: () => T0 },
      rng: () => 0,
      fetcher,
      keyState,
    });
    return handler(
      new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${LGK}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }) as unknown as Parameters<typeof handler>[0],
    );
  }

  it("returns 502 UPSTREAM_ERROR when all attempts fail", async () => {
    await seedConfig();
    const fetcher = mockFetcher([new Response("oops", { status: 500 })]);
    const resp = await gateway(fetcher, { model: "m1" });
    expect(resp.status).toBe(502);
    const err = (await resp.json()) as { error: { code: string } };
    expect(err.error.code).toBe("UPSTREAM_ERROR");
  });

  it("returns 503 NO_CHANNEL for an unmapped model and 401 for bad access keys", async () => {
    await seedConfig();
    const resp = await gateway(mockFetcher([new Response("{}")]), { model: "unknown" });
    expect(resp.status).toBe(503);

    const unauthorized = await gateway(mockFetcher([]), { model: "m1" }, { accessKey: "lgk_wrong" });
    expect(unauthorized.status).toBe(401);
  });

  it("mirrors the worker layer: authorization gates routing (multi-user 04)", async () => {
    await seedConfig();
    // 撤掉全部授权：key 有效但无 grant → 503 NO_CHANNEL（而非 401/500）。
    await adminDb.run("DELETE FROM user_key_grant", []);
    cache.invalidate();
    const denied = await gateway(mockFetcher([new Response("{}")]), { model: "m1" });
    expect(denied.status).toBe(503);
    const err = (await denied.json()) as { error: { code: string } };
    expect(err.error.code).toBe("NO_CHANNEL");
  });
});

describe("sqlite adapter: admin API (shared handleAdmin)", () => {
  function adminReq(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
    return new Request(`http://gw${path}`, {
      method,
      headers: { "x-admin-token": "admin-secret", "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function adminDeps(creds: Partial<Parameters<typeof handleAdmin>[1]["credentials"]> = {}) {
    return {
      db: adminDb,
      credentials: { adminToken: srvEnv.adminToken, ...creds },
      encryptionKey: srvEnv.encryptionKey,
      invalidate: () => cache.invalidate(),
      now: () => T0,
    };
  }

  it("performs provider/key/mapping CRUD with encrypted keys", async () => {
    const created = await handleAdmin(
      adminReq("POST", "/admin/providers", { name: "p-a", endpoints: { openai: "https://a.test" } }),
      adminDeps(),
    );
    expect(created.status).toBe(201);
    const provider = (await created.json()) as { id: string };

    const keyResp = await handleAdmin(
      adminReq("POST", "/admin/keys", { provider_id: provider.id, api_key: "sk-hush-secret-1234" }),
      adminDeps(),
    );
    expect(keyResp.status).toBe(201);
    const keyBody = await keyResp.text();
    expect(keyBody).not.toContain("sk-hush-secret");
    expect(keyBody).not.toContain("encrypted");
    expect(keyBody).toContain("1234");

    // DB row is ciphertext.
    const rows = await adminDb.all<{ encrypted_key: string }>("SELECT encrypted_key FROM provider_key", []);
    expect(rows[0]!.encrypted_key).not.toContain("sk-hush-secret");

    const mapping = await handleAdmin(
      adminReq("POST", "/admin/mappings", { client_model: "m1", provider_id: provider.id, upstream_model: "a-up" }),
      adminDeps(),
    );
    expect(mapping.status).toBe(201);

    const list = await handleAdmin(adminReq("GET", "/admin/keys"), adminDeps());
    const listBody = await list.text();
    expect(listBody).not.toContain("encrypted");
  });

  it("rejects gateway tokens and wrong admin tokens", async () => {
    const gwToken = await handleAdmin(
      adminReq("GET", "/admin/providers", undefined, { "x-admin-token": "", authorization: "Bearer gw-token" }),
      adminDeps(),
    );
    expect(gwToken.status).toBe(401);

    const wrong = await handleAdmin(
      adminReq("GET", "/admin/providers", undefined, { "x-admin-token": "wrong" }),
      adminDeps(),
    );
    expect(wrong.status).toBe(401);
  });

  it("enforces the optional IP allowlist (server form, spec §3.5)", async () => {
    const denied = await handleAdmin(
      adminReq("GET", "/admin/providers"),
      adminDeps({ allowedIps: ["127.0.0.1"], clientIp: "203.0.113.9" }),
    );
    expect(denied.status).toBe(403);

    const allowed = await handleAdmin(
      adminReq("GET", "/admin/providers"),
      adminDeps({ allowedIps: ["127.0.0.1"], clientIp: "127.0.0.1" }),
    );
    expect(allowed.status).toBe(200);

    // Unknown client IP (no TRUST_PROXY) is also denied when a list is set.
    const unknown = await handleAdmin(
      adminReq("GET", "/admin/providers"),
      adminDeps({ allowedIps: ["127.0.0.1"], clientIp: null as unknown as string }),
    );
    expect(unknown.status).toBe(403);
  });

  it("paginates /admin/logs with a stable keyset cursor", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      const id = `V1StGXR8_Z5jdHi6B-m${String.fromCharCode(97 + i)}X`;
      ids.push(id);
      await adminDb.run(
        "INSERT INTO request_log (id, request_id, ts, client_model, status) VALUES (?, 'r', ?, 'm1', 200)",
        [id, T0],
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const resp = await handleAdmin(
        adminReq("GET", `/admin/logs?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
        adminDeps(),
      );
      const body = (await resp.json()) as { logs: Array<{ id: string }>; next_cursor: string | null };
      seen.push(...body.logs.map((l) => l.id));
      cursor = body.next_cursor;
    } while (cursor !== null);
    expect(seen.length).toBe(15);
    expect(new Set(seen).size).toBe(15);
    expect([...seen].sort().reverse()).toEqual([...ids].sort().reverse());
  });

  it("writes audit rows for admin writes", async () => {
    await handleAdmin(
      adminReq("POST", "/admin/providers", { name: "p-a", endpoints: { openai: "https://a.test" } }),
      adminDeps(),
    );
    const audit = await adminDb.all<{ action: string }>("SELECT action FROM admin_audit", []);
    expect(audit.map((a) => a.action)).toEqual(["provider.create"]);
  });
});

// ---- 访问控制字段（access-control 01，server 镜像子集）---------------------------

describe("sqlite adapter: access-control fields (access-control 01)", () => {
  const T1 = T0 + 7 * 86_400_000;

  function req(method: string, path: string, token: string, body?: unknown): Request {
    return new Request(`http://gw${path}`, {
      method,
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function call(method: string, path: string, token = "admin-secret", body?: unknown): Promise<Response> {
    return handleAdmin(req(method, path, token, body), {
      db: adminDb,
      credentials: { adminToken: srvEnv.adminToken },
      encryptionKey: srvEnv.encryptionKey,
      invalidate: () => cache.invalidate(),
      now: () => T0,
    });
  }

  it("lgk_ create/update carries expires_at + ip_allowlist; snapshot parses the JSON column", async () => {
    const userResp = await call("POST", "/admin/users", undefined, { name: "alice", role: "user" });
    const alice = (await userResp.json()) as { id: string; management_token: string };

    const created = await call("POST", "/admin/access-keys", alice.management_token, {
      name: "scene-1", expires_at: T1, ip_allowlist: ["10.0.0.0/8", "fe80::/10"],
    });
    expect(created.status).toBe(201);
    const key = (await created.json()) as { id: string; expires_at: number; ip_allowlist: string[] };
    expect(key).toMatchObject({ expires_at: T1, ip_allowlist: ["10.0.0.0/8", "fe80::/10"] });

    const snapshot = await new SqlConfigStore(adminDb).getActiveConfig();
    expect(snapshot.access_keys.find((k) => k.id === key.id)).toMatchObject({
      expires_at: T1, ip_allowlist: ["10.0.0.0/8", "fe80::/10"],
    });

    // 非法 CIDR → 400（server 形态同样经共享校验）。
    expect((await call("POST", "/admin/access-keys", alice.management_token, { name: "bad", ip_allowlist: ["10.0.0.0/33"] })).status).toBe(400);
  });

  it("lgm_ reset accepts expires_at; PUT changes expiry only (hash untouched)", async () => {
    const userResp = await call("POST", "/admin/users", undefined, { name: "root", role: "administrator" });
    const root = (await userResp.json()) as { id: string; management_token: string };
    // root 建好后引导 ADMIN_TOKEN 失效，改用 lgm_。
    const bobResp = await call("POST", "/admin/users", root.management_token, { name: "bob", role: "user" });
    const bob = (await bobResp.json()) as { id: string };

    const reset = await call("POST", `/admin/users/${bob.id}/token`, root.management_token, { expires_at: T1 });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ user_id: bob.id, expires_at: T1 });

    const before = await adminDb.all<{ token_hash: string }>("SELECT token_hash FROM management_token WHERE user_id = ?", [bob.id]);
    const put = await call("PUT", `/admin/users/${bob.id}/token`, root.management_token, { expires_at: 0 });
    expect(put.status).toBe(200);
    expect(JSON.stringify(await put.json())).not.toContain("lgm_");
    const after = await adminDb.all<{ token_hash: string; expires_at: number }>("SELECT token_hash, expires_at FROM management_token WHERE user_id = ?", [bob.id]);
    expect(after[0]).toMatchObject({ token_hash: before[0]!.token_hash, expires_at: 0 });

    // 用户列表携带 token_expires_at / token_last_used_at：bob 的 token 从未
    // 使用 → 0；root 的 token 刚被这些管理调用命中 → last_used_at = T0（02 起
    // 每次命中内联更新）。
    const list = (await (await call("GET", "/admin/users", root.management_token)).json()) as Array<{
      id: string; token_expires_at: number; token_last_used_at: number;
    }>;
    expect(list.find((u) => u.id === bob.id)).toMatchObject({ token_expires_at: 0, token_last_used_at: 0 });
    expect(list.find((u) => u.id === root.id)).toMatchObject({ token_expires_at: 0, token_last_used_at: T0 });
  });
});

describe("sqlite adapter: log sink", () => {
  it("writes asynchronously and never rejects", async () => {
    const sink = new SqliteLogSink(db, { now: () => T0 });
    await sink.write({
      id: "V1StGXR8_Z5jdHi6B-myA", request_id: "r1", ts: T0,
      client_model: "m1", status: 200, latency_ms: 5,
    });
    const rows = await adminDb.all("SELECT * FROM request_log", []);
    expect(rows.length).toBe(1);
  });

  it("retention deletes rows older than 14 days", async () => {
    await adminDb.run(
      "INSERT INTO request_log (id, request_id, ts, client_model, status) VALUES ('V1StGXR8_Z5jdHi6B-zz1', 'old', 1, 'm1', 200)",
      [],
    );
    const sink = new SqliteLogSink(db, { now: () => T0 });
    await sink.write({
      id: "V1StGXR8_Z5jdHi6B-zz2", request_id: "r2", ts: T0,
      client_model: "m1", status: 200,
    });
    const rows = await adminDb.all("SELECT id FROM request_log", []);
    expect(rows.length).toBe(1);
    expect((rows[0] as { id: string }).id).toBe("V1StGXR8_Z5jdHi6B-zz2");
  });
});

describe("server app routing (Hono)", () => {
  it("health, auth gate and bare /admin all route correctly", async () => {
    const app = createApp({ env: env(), dbPath: ":memory:" });
    const health = await app.request("http://gw/health");
    expect(health.status).toBe(200);

    // 鉴权先于路由：独立空库（无访问 key）上 /nope 也回 401。
    const unauth = await app.request("http://gw/nope", { headers: { authorization: `Bearer ${LGK}` } });
    expect(unauth.status).toBe(401);
    const authErr = (await unauth.json()) as { error: { code: string } };
    expect(authErr.error.code).toBe("UNAUTHORIZED");

    // Bare /admin must hit the admin plane (401), not the gateway 404.
    const bare = await app.request("http://gw/admin");
    expect(bare.status).toBe(401);

    const withCreds = await app.request("http://gw/admin/providers", { headers: { "x-admin-token": "admin-secret" } });
    expect(withCreds.status).toBe(200);
  });

  it("/version 注入发布信息；缺省（无 release-info.json）回退空信息仍 200", async () => {
    // 注入缝（部署脚本生成 release-info.json → compose 卷挂载 → loadReleaseInfo 读取）。
    const injected = createApp({
      env: env(),
      dbPath: ":memory:",
      releaseInfo: {
        tag: "v1.3.0",
        commit: "9d62c6dfb3d4e0efe3c7d66ee94593adc4e5d800",
      },
    });
    const resp = await injected.request("http://gw/version");
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { tag: string | null; commit: string | null; gateway_version: string };
    expect(body.tag).toBe("v1.3.0");
    expect(body.commit).toBe("9d62c6dfb3d4e0efe3c7d66ee94593adc4e5d800");
    expect(body.gateway_version.length).toBeGreaterThan(0);

    // 默认路径：本地开发/未注入部署没有 release-info.json → 空信息不 5xx。
    // （测试 CWD 可能有 dev 生成的真实文件——显式指到不存在的路径保证口径。）
    const saved = process.env.RELEASE_INFO_PATH;
    process.env.RELEASE_INFO_PATH = "./nonexistent-release-info.json";
    try {
      const bare = createApp({ env: env(), dbPath: ":memory:" });
      const fallback = await bare.request("http://gw/version");
      expect(fallback.status).toBe(200);
      const empty = (await fallback.json()) as { tag: string | null; commit: string | null };
      expect(empty.tag).toBeNull();
      expect(empty.commit).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.RELEASE_INFO_PATH;
      else process.env.RELEASE_INFO_PATH = saved;
    }
  });

  it("CORS：跨源 fetch 带 ACAO 头，OPTIONS 预检放行 x-admin-token", async () => {
    const app = createApp({ env: env(), dbPath: ":memory:" });
    // 预检：204 + 放行自定义头（本地 web :5173 跨源实录——无 CORS 头时管理端 fetch 被浏览器整体拦掉）。
    const preflight = await app.request("http://gw/version", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET", "access-control-request-headers": "x-admin-token,content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-admin-token");
    // 实际响应同样带 ACAO，浏览器才放行读 body。
    const actual = await app.request("http://gw/version", { headers: { origin: "http://localhost:5173" } });
    expect(actual.status).toBe(200);
    expect(actual.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("loadEnv rejects missing required variables", () => {
    let threw = false;
    try {
      loadEnv({});
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("loadEnv TLS paths are optional but must come in pairs (self-signed https form)", () => {
    const base = { ADMIN_TOKEN: "a", ENCRYPTION_KEY: "b" };
    const none = loadEnv(base);
    expect(none.tlsCertPath).toBeNull();
    expect(none.tlsKeyPath).toBeNull();

    const both = loadEnv({ ...base, TLS_CERT_PATH: "/c.pem", TLS_KEY_PATH: "/k.pem" });
    expect(both.tlsCertPath).toBe("/c.pem");
    expect(both.tlsKeyPath).toBe("/k.pem");

    let threw = false;
    try {
      loadEnv({ ...base, TLS_CERT_PATH: "/c.pem" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ---- 管理面身份鉴权（multi-user 02，worker 层用例的镜像子集）--------------------

describe("sqlite adapter: management-plane identity auth (multi-user 02)", () => {
  function reqAs(token: string, method: string, path: string, body?: unknown): Request {
    return new Request(`http://gw${path}`, {
      method,
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const deps = () => ({
    db: adminDb,
    credentials: { adminToken: srvEnv.adminToken },
    now: () => T0,
  });

  it("resolves lgm_ identity, gates the user role and retires ADMIN_TOKEN after bootstrap", async () => {
    // 无启用管理员：ADMIN_TOKEN 引导创建第一个 administrator。
    const created = await handleAdmin(reqAs("admin-secret", "POST", "/admin/users", { name: "root", role: "administrator" }), deps());
    expect(created.status).toBe(201);
    const root = (await created.json()) as { id: string; management_token: string };

    const me = await handleAdmin(reqAs(root.management_token, "GET", "/admin/me"), deps());
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: root.id, name: "root", role: "administrator" });

    // 存在启用 administrator 后 ADMIN_TOKEN 失效（引导凭证不构成长期后门）。
    expect((await handleAdmin(reqAs("admin-secret", "GET", "/admin/providers"), deps())).status).toBe(401);

    // user 角色：自己的身份可见，全局资源 403，审计记录真实 actor。
    const made = await handleAdmin(reqAs(root.management_token, "POST", "/admin/users", { name: "alice", role: "user" }), deps());
    expect(made.status).toBe(201);
    const alice = (await made.json()) as { id: string; management_token: string };

    expect((await handleAdmin(reqAs(alice.management_token, "GET", "/admin/me"), deps())).status).toBe(200);
    const forbidden = await handleAdmin(reqAs(alice.management_token, "GET", "/admin/providers"), deps());
    expect(forbidden.status).toBe(403);

    const audit = (await adminDb.all(
      "SELECT actor_user_id FROM admin_audit WHERE action = 'user.create' AND target = ?",
      [alice.id],
    )) as Array<{ actor_user_id: string | null }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_user_id).toBe(root.id);
  });
});

// ---- 访问 key 与授权（multi-user 03，worker 层用例的镜像子集）--------------------

describe("sqlite adapter: access keys & grants (multi-user 03)", () => {
  function reqAs(token: string, method: string, path: string, body?: unknown): Request {
    return new Request(`http://gw${path}`, {
      method,
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const deps = () => ({
    db: adminDb,
    credentials: { adminToken: srvEnv.adminToken },
    encryptionKey: srvEnv.encryptionKey,
    now: () => T0,
  });

  it("manages lgk_ keys with ownership scoping and grants with replace-all", async () => {
    // 引导链：建 provider/key → root 管理员 → alice。
    const provider = await handleAdmin(
      reqAs("admin-secret", "POST", "/admin/providers", { name: "p-g", endpoints: { openai: "https://g.test" } }),
      deps(),
    );
    const providerId = ((await provider.json()) as { id: string }).id;
    const keyResp = await handleAdmin(
      reqAs("admin-secret", "POST", "/admin/keys", { provider_id: providerId, api_key: "sk-up-aaaa" }),
      deps(),
    );
    const providerKeyId = ((await keyResp.json()) as { id: string }).id;

    const rootResp = await handleAdmin(reqAs("admin-secret", "POST", "/admin/users", { name: "root", role: "administrator" }), deps());
    const root = (await rootResp.json()) as { id: string; management_token: string };
    const aliceResp = await handleAdmin(reqAs(root.management_token, "POST", "/admin/users", { name: "alice", role: "user" }), deps());
    const alice = (await aliceResp.json()) as { id: string; management_token: string };

    // 授权整组替换 + 去重。
    const put = await handleAdmin(
      reqAs(root.management_token, "PUT", `/admin/users/${alice.id}/grants`, { provider_key_ids: [providerKeyId, providerKeyId] }),
      deps(),
    );
    expect(put.status).toBe(200);
    const grants = (await put.json()) as { grants: Array<{ provider_key_id: string; provider_name: string; key_hint: string }> };
    expect(grants.grants).toHaveLength(1);
    expect(grants.grants[0]).toMatchObject({ provider_key_id: providerKeyId, provider_name: "p-g", key_hint: "aaaa" });
    expect((await handleAdmin(
      reqAs(root.management_token, "PUT", `/admin/users/${alice.id}/grants`, { provider_key_ids: ["nope"] }),
      deps(),
    )).status).toBe(404);

    // alice 自建 lgk_：一次性明文 + 列表仅元数据 + 归属取自身份。
    const created = await handleAdmin(reqAs(alice.management_token, "POST", "/admin/access-keys", { name: "scene-1" }), deps());
    expect(created.status).toBe(201);
    const key = (await created.json()) as { id: string; user_id: string; access_key: string };
    expect(key.access_key).toMatch(/^lgk_/);
    expect(key.user_id).toBe(alice.id);
    const listResp = await handleAdmin(reqAs(alice.management_token, "GET", "/admin/access-keys"), deps());
    expect(await listResp.text()).not.toContain("lgk_");

    // administrator 代建。
    const behalf = await handleAdmin(
      reqAs(root.management_token, "POST", `/admin/users/${alice.id}/access-keys`, { name: "ops" }),
      deps(),
    );
    expect(behalf.status).toBe(201);

    // 删除用户级联清理访问 key 与授权。
    const del = await handleAdmin(reqAs(root.management_token, "DELETE", `/admin/users/${alice.id}`), deps());
    expect(del.status).toBe(200);
    const leftover = (await adminDb.all("SELECT COUNT(*) AS n FROM access_key", [])) as Array<{ n: number }>;
    const leftoverGrants = (await adminDb.all("SELECT COUNT(*) AS n FROM user_key_grant", [])) as Array<{ n: number }>;
    expect(leftover[0]!.n).toBe(0);
    expect(leftoverGrants[0]!.n).toBe(0);
  });
});

// ---- 限额（quota 01，worker 层用例的镜像子集）------------------------------------

describe("sqlite adapter: quota limits (quota 01)", () => {
  function reqAs(token: string, method: string, path: string, body?: unknown): Request {
    return new Request(`http://gw${path}`, {
      method,
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const deps = () => ({
    db: adminDb,
    credentials: { adminToken: srvEnv.adminToken },
    encryptionKey: srvEnv.encryptionKey,
    now: () => T0,
  });

  /** 引导链：provider + 上游 key（资产级限额）→ root 管理员 → alice。 */
  async function quotaFixture() {
    const provider = await handleAdmin(
      reqAs("admin-secret", "POST", "/admin/providers", { name: "p-q", endpoints: { openai: "https://q.test" } }),
      deps(),
    );
    const providerId = ((await provider.json()) as { id: string }).id;
    const keyResp = await handleAdmin(
      reqAs("admin-secret", "POST", "/admin/keys", { provider_id: providerId, api_key: "sk-up-qqqq", daily_token_limit: 1_000_000, daily_request_limit: 500 }),
      deps(),
    );
    const providerKeyId = ((await keyResp.json()) as { id: string; daily_token_limit: number }).id;
    const rootResp = await handleAdmin(reqAs("admin-secret", "POST", "/admin/users", { name: "root", role: "administrator" }), deps());
    const root = (await rootResp.json()) as { id: string; management_token: string };
    const aliceResp = await handleAdmin(reqAs(root.management_token, "POST", "/admin/users", { name: "alice", role: "user" }), deps());
    const alice = (await aliceResp.json()) as { id: string; management_token: string };
    return { providerId, providerKeyId, root, alice };
  }

  it("sets asset-level limits on provider keys and updates them via PUT", async () => {
    const { providerKeyId, root } = await quotaFixture();
    const created = await handleAdmin(reqAs(root.management_token, "GET", "/admin/keys"), deps());
    const list = (await created.json()) as Array<{ id: string; daily_token_limit: number; daily_request_limit: number }>;
    expect(list.find((k) => k.id === providerKeyId)).toMatchObject({ daily_token_limit: 1_000_000, daily_request_limit: 500 });

    const put = await handleAdmin(reqAs(root.management_token, "PUT", `/admin/keys/${providerKeyId}`, { daily_token_limit: 2_000_000 }), deps());
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ id: providerKeyId, daily_token_limit: 2_000_000, daily_request_limit: 500 });

    // 非法输入 → 400。
    expect((await handleAdmin(reqAs(root.management_token, "PUT", `/admin/keys/${providerKeyId}`, { daily_request_limit: -1 }), deps())).status).toBe(400);
  });

  it("accepts grants in both input shapes and shows budgets in GET/me views", async () => {
    const { providerKeyId, root, alice } = await quotaFixture();
    type GrantView = { provider_key_id: string; daily_token_limit: number; daily_request_limit: number };

    const put = await handleAdmin(
      reqAs(root.management_token, "PUT", `/admin/users/${alice.id}/grants`, {
        provider_key_ids: [{ provider_key_id: providerKeyId, daily_token_limit: 300_000, daily_request_limit: 1000 }],
      }),
      deps(),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { grants: GrantView[] }).grants[0]).toMatchObject({ daily_token_limit: 300_000, daily_request_limit: 1000 });

    // 旧形状（纯字符串）向后兼容 = 不限额。
    const legacy = await handleAdmin(
      reqAs(root.management_token, "PUT", `/admin/users/${alice.id}/grants`, { provider_key_ids: [providerKeyId] }),
      deps(),
    );
    expect(legacy.status).toBe(200);
    expect(((await legacy.json()) as { grants: GrantView[] }).grants[0]).toMatchObject({ daily_token_limit: 0, daily_request_limit: 0 });

    // me/grants 视图带限额字段。
    const made = await handleAdmin(reqAs(alice.management_token, "POST", "/admin/access-keys", { name: "q", daily_token_limit: 10 }), deps());
    expect(made.status).toBe(201);
    const me = (await (await handleAdmin(reqAs(alice.management_token, "GET", "/admin/me/grants"), deps())).json()) as { grants: GrantView[] };
    expect(me.grants[0]).toMatchObject({ provider_key_id: providerKeyId, daily_token_limit: 0, daily_request_limit: 0 });
  });

  it("lets users set their own access-key limits and admins edit any key", async () => {
    const { root, alice } = await quotaFixture();
    const created = await handleAdmin(
      reqAs(alice.management_token, "POST", "/admin/access-keys", { name: "scene", daily_token_limit: 50_000, daily_request_limit: 100, max_concurrency: 4 }),
      deps(),
    );
    expect(created.status).toBe(201);
    const key = (await created.json()) as { id: string; daily_token_limit: number; max_concurrency: number };
    expect(key).toMatchObject({ daily_token_limit: 50_000, max_concurrency: 4 });

    const put = await handleAdmin(reqAs(alice.management_token, "PUT", `/admin/access-keys/${key.id}`, { max_concurrency: 8 }), deps());
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ id: key.id, daily_token_limit: 50_000, max_concurrency: 8 });

    // administrator 可改任意 key；非法输入 → 400。
    expect((await handleAdmin(reqAs(root.management_token, "PUT", `/admin/access-keys/${key.id}`, { daily_token_limit: 1 }), deps())).status).toBe(200);
    expect((await handleAdmin(reqAs(alice.management_token, "PUT", `/admin/access-keys/${key.id}`, { daily_token_limit: -3 }), deps())).status).toBe(400);
  });

  it("carries quota fields into the config snapshot (0 = unlimited)", async () => {
    const { providerKeyId, root, alice } = await quotaFixture();
    await handleAdmin(
      reqAs(root.management_token, "PUT", `/admin/users/${alice.id}/grants`, {
        provider_key_ids: [{ provider_key_id: providerKeyId, daily_token_limit: 55, daily_request_limit: 66 }],
      }),
      deps(),
    );
    const created = await handleAdmin(
      reqAs(alice.management_token, "POST", "/admin/access-keys", { name: "snap", daily_token_limit: 11, daily_request_limit: 22, max_concurrency: 3 }),
      deps(),
    );
    const keyId = ((await created.json()) as { id: string }).id;

    const config = await new SqlConfigStore(adminDb).getActiveConfig();
    expect(config.keys.find((k) => k.id === providerKeyId)).toMatchObject({ daily_token_limit: 1_000_000, daily_request_limit: 500 });
    expect(config.access_keys.find((k) => k.id === keyId)).toMatchObject({ daily_token_limit: 11, daily_request_limit: 22, max_concurrency: 3 });
    expect(config.grants.find((g) => g.user_id === alice.id && g.provider_key_id === providerKeyId)).toMatchObject({ daily_token_limit: 55, daily_request_limit: 66 });
  });
});

// ---- 网关准入（quota 02，worker 层用例的镜像子集）--------------------------------

describe("sqlite adapter: gateway quota admission (quota 02)", () => {
  const okFetcher: Fetcher = {
    fetch: async () =>
      new Response(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  };

  function quotaGateway(fetcher: Fetcher, ledger: QuotaLedger) {
    return createGatewayHandler({
      // 不走缓存：SQL 改限额后下一请求立刻生效。
      getConfig: () => new SqlConfigStore(adminDb).getActiveConfig(),
      resolveKey: async (key) =>
        decryptApiKey(await importEncryptionKey(TEST_ENCRYPTION_KEY), key.encrypted_key),
      logSink,
      clock: { now: () => T0 },
      rng: () => 0,
      fetcher,
      keyState: new InMemoryKeyState(),
      quota: ledger,
    });
  }

  function chat(body: unknown = { model: "m1", messages: [] }): Request {
    return new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${LGK}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects beyond the access-key request limit without logging the rejection", async () => {
    await seedConfig();
    await adminDb.run("UPDATE access_key SET daily_request_limit = 1 WHERE id = ?", [AKID]);
    const ledger = new QuotaLedger({ db: adminDb, clock: { now: () => T0 } });
    const handler = quotaGateway(okFetcher, ledger);

    expect((await handler(chat())).status).toBe(200);
    const second = await handler(chat());
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      error: { code: "RATE_LIMITED_LOCAL", message: "access key request quota exceeded" },
    });
    // 拒绝不留痕。
    const rows = (await adminDb.all("SELECT COUNT(*) AS n FROM request_log", [])) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });

  it("enforces grant-level budgets with the level named in the message", async () => {
    await seedConfig();
    await adminDb.run("UPDATE user_key_grant SET daily_token_limit = 5 WHERE user_id = ?", [UID]);
    const handler = quotaGateway(okFetcher, new QuotaLedger({ db: adminDb, clock: { now: () => T0 } }));

    expect((await handler(chat())).status).toBe(200); // 7 tokens 越限记账
    const second = await handler(chat());
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      error: { message: "user grant token quota exceeded" },
    });
  });

  it("leaves unlimited keys completely untouched (v1.0 behavior, zero ledger reads)", async () => {
    await seedConfig();
    const counting: AdminDb = {
      all: (sql, params) => adminDb.all(sql, params),
      run: (sql, params) => adminDb.run(sql, params),
    };
    let reads = 0;
    counting.all = (sql, params) => {
      reads++;
      return adminDb.all(sql, params);
    };
    const handler = quotaGateway(okFetcher, new QuotaLedger({ db: counting, clock: { now: () => T0 } }));

    expect((await handler(chat())).status).toBe(200);
    expect((await handler(chat())).status).toBe(200);
    expect(reads).toBe(0);
  });
});

// ---- 用量聚合（multi-user 05，worker 层用例的镜像子集）--------------------------

describe("sqlite adapter: usage aggregation (multi-user 05)", () => {
  const deps = () => ({
    db: adminDb,
    credentials: { adminToken: srvEnv.adminToken },
    now: () => T0,
  });

  async function seedUsage(): Promise<{ aliceId: string; aliceToken: string; bobId: string; rootToken: string }> {
    // 引导建 root → root 建 alice/bob；各自种两行归属日志。
    const root = (await (await handleAdmin(
      new Request("http://gw/admin/users", {
        method: "POST",
        headers: { "x-admin-token": "admin-secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "root", role: "administrator" }),
      }),
      deps(),
    )).json()) as { management_token: string };
    const mkUser = async (name: string) => {
      const resp = await handleAdmin(
        new Request("http://gw/admin/users", {
          method: "POST",
          headers: { "x-admin-token": root.management_token, "content-type": "application/json" },
          body: JSON.stringify({ name, role: "user" }),
        }),
        deps(),
      );
      return (await resp.json()) as { id: string; management_token: string };
    };
    const alice = await mkUser("alice");
    const bob = await mkUser("bob");
    const rows: Array<[string, string | null, string, number, number, number, number]> = [
      // id, user_id, client_model, prompt, completion, latency, status
      ["V1StGXR8_Z5jdHi6B-u01", alice.id, "m1", 10, 5, 100, 200],
      ["V1StGXR8_Z5jdHi6B-u02", alice.id, "m1", 20, 10, 300, 502],
      ["V1StGXR8_Z5jdHi6B-u03", bob.id, "m1", 99, 99, 999, 200],
    ];
    for (let i = 0; i < rows.length; i++) {
      const [id, userId, model, prompt, completion, latency, status] = rows[i]!;
      await adminDb.run(
        "INSERT INTO request_log (id, request_id, ts, client_model, user_id, access_key_id, prompt_tokens, completion_tokens, latency_ms, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [id, `req-${i}`, T0 + i, model, userId, "V1StGXR8_Z5jdHi6B-ak1", prompt, completion, latency, status],
      );
    }
    return { aliceId: alice.id, aliceToken: alice.management_token, bobId: bob.id, rootToken: root.management_token };
  }

  function usageReq(token: string, query: string): Request {
    return new Request(`http://gw/admin/usage${query}`, { headers: { "x-admin-token": token } });
  }

  it("aggregates grouped by key and enforces user-role scoping in SQL", async () => {
    const f = await seedUsage();

    // user 角色只聚合自己的行：2 请求 1 错误、30/15 tokens、平均 200。
    const own = (await (await handleAdmin(usageReq(f.aliceToken, "?group_by=key"), deps())).json()) as {
      usage: Array<Record<string, unknown>>;
    };
    expect(own.usage).toHaveLength(1);
    expect(own.usage[0]).toMatchObject({
      access_key_id: "V1StGXR8_Z5jdHi6B-ak1",
      requests: 2, errors: 1, prompt_tokens: 30, completion_tokens: 15, avg_latency_ms: 200,
    });

    // user 角色传 user_id → 403。
    expect((await handleAdmin(usageReq(f.aliceToken, `?user_id=${f.bobId}`), deps())).status).toBe(403);
  });

  it("lets the user role read /admin/logs scoped to own rows in SQL (desktop 04)", async () => {
    const f = await seedUsage();

    // user 角色：只回自己的 2 行（SQL 钉定，同 usage 范式）。
    const ownResp = await handleAdmin(
      new Request("http://gw/admin/logs", { headers: { "x-admin-token": f.aliceToken } }),
      deps(),
    );
    expect(ownResp.status).toBe(200);
    const own = (await ownResp.json()) as { logs: Array<{ user_id: string | null }> };
    expect(own.logs).toHaveLength(2);
    expect(own.logs.every((l) => l.user_id === f.aliceId)).toBe(true);

    // user 角色传 user_id  widening 参数被忽略（listLogs 不接受 user_id，恒钉定自己）。
    const widened = (await (await handleAdmin(
      new Request(`http://gw/admin/logs?user_id=${f.bobId}`, { headers: { "x-admin-token": f.aliceToken } }),
      deps(),
    )).json()) as { logs: Array<{ user_id: string | null }> };
    expect(widened.logs.every((l) => l.user_id === f.aliceId)).toBe(true);

    // administrator 仍见全局 3 行。
    const allResp = await handleAdmin(
      new Request("http://gw/admin/logs", { headers: { "x-admin-token": f.rootToken } }),
      deps(),
    );
    expect(allResp.status).toBe(200);
    const all = (await allResp.json()) as { logs: unknown[] };
    expect(all.logs).toHaveLength(3);
  });

  it("serves the gateway-defined day window and returns window_start (today=1)", async () => {
    const f = await seedUsage();
    const start = dayWindowStart(T0);
    const today = (await (await handleAdmin(usageReq(f.rootToken, "?today=1&group_by=key"), deps())).json()) as {
      window_start: number;
      usage: Array<Record<string, unknown>>;
    };
    expect(today.window_start).toBe(start);
    const explicit = (await (await handleAdmin(usageReq(f.rootToken, `?group_by=key&from=${start}`), deps())).json()) as {
      usage: Array<Record<string, unknown>>;
    };
    expect(today.usage).toEqual(explicit.usage);
  });

  it("rejects today=1 combined with from/to", async () => {
    const f = await seedUsage();
    expect((await handleAdmin(usageReq(f.rootToken, `?today=1&from=${T0}`), deps())).status).toBe(400);
    expect((await handleAdmin(usageReq(f.rootToken, `?today=1&to=${T0}`), deps())).status).toBe(400);
    expect((await handleAdmin(usageReq(f.rootToken, "?today=0"), deps())).status).toBe(400);
  });
});

// ---- 访问控制准入与 lgm_ 生命周期（access-control 02，server 镜像子集）--------

describe("sqlite adapter: access-control admission (access-control 02)", () => {
  it("rejects an expired lgk_ with 401 and admits inside the TTL window (snapshot semantics)", async () => {
    await seedConfig();
    const fetcher = mockFetcher([
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    // 窗口内（T0 < expires_at）放行。
    await adminDb.run("UPDATE access_key SET expires_at = ? WHERE id = ?", [T0 + 60_000, AKID]);
    cache.invalidate();
    expect((await gateway(fetcher, { model: "m1", messages: [] })).status).toBe(200);

    // 已过期（expires_at ≤ T0，时钟注入）→ 401，不写 request_log。
    await adminDb.run("UPDATE access_key SET expires_at = ? WHERE id = ?", [T0, AKID]);
    cache.invalidate();
    const denied = await gateway(fetcher, { model: "m1", messages: [] });
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: "UNAUTHORIZED" } });
    const rows = await adminDb.all("SELECT * FROM request_log", []);
    expect(rows).toHaveLength(1); // 仅此前成功请求一行
  });

  it("enforces the lgk_ IP allowlist via the clientIp seam (TRUST_PROXY semantics)", async () => {
    await seedConfig();
    await adminDb.run(`UPDATE access_key SET ip_allowlist = '["10.0.0.0/8", "2001:db8::/32"]' WHERE id = ?`, [AKID]);
    cache.invalidate();
    // 每次调用产新 Response（body 只能消费一次，多请求不能复用同一对象）。
    const fetcher = {
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
    } as Fetcher;

    // 命中 v4 网段 / v6 网段 → 放行。
    expect((await gateway(fetcher, { model: "m1" }, { clientIp: () => "10.1.2.3" })).status).toBe(200);
    expect((await gateway(fetcher, { model: "m1" }, { clientIp: () => "2001:db8::7" })).status).toBe(200);
    // 网段外 → 403 IP_NOT_ALLOWED。
    const denied = await gateway(fetcher, { model: "m1" }, { clientIp: () => "192.0.2.1" });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: "IP_NOT_ALLOWED" } });
    // 无 TRUST_PROXY → 未知 IP + 已设列表 → 403（与 admin 面 ALLOWED_IPS 一致）。
    expect((await gateway(fetcher, { model: "m1" }, { clientIp: () => null })).status).toBe(403);
    // 拒绝不留痕。
    const rows = await adminDb.all("SELECT * FROM request_log", []);
    expect(rows).toHaveLength(2); // 仅两次成功请求
  });

  it("lgm_ expiry is realtime and hits update last_used_at; virtual admin writes nothing", async () => {
    // /admin/me 对两种身份都可用（虚拟管理员 userId 为空、user 角色自助）。
    const req = (token?: string) => new Request("http://gw/admin/me", {
      headers: token === undefined ? {} : { "x-admin-token": token },
    });
    const deps = () => ({
      db: adminDb,
      credentials: { adminToken: srvEnv.adminToken },
      encryptionKey: srvEnv.encryptionKey,
      invalidate: () => cache.invalidate(),
      now: () => T0,
    });

    // 引导虚拟管理员（无用户、无 token 行）：不写 last_used_at。
    expect((await handleAdmin(req("admin-secret"), deps())).status).toBe(200);
    expect(await adminDb.all("SELECT COUNT(*) AS n FROM management_token", [])).toMatchObject([{ n: 0 }]);

    // lgm_ 有效命中：last_used_at = T0（时钟注入精确写入）。
    const created = await handleAdmin(
      new Request("http://gw/admin/users", {
        method: "POST",
        headers: { "x-admin-token": "admin-secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "alice", role: "user" }),
      }),
      deps(),
    );
    const alice = (await created.json()) as { id: string; management_token: string };
    expect((await handleAdmin(req(alice.management_token), deps())).status).toBe(200);
    expect(
      await adminDb.all("SELECT last_used_at FROM management_token WHERE user_id = ?", [alice.id]),
    ).toMatchObject([{ last_used_at: T0 }]);

    // 实时过期（expires_at ≤ now）→ 401；再命中不更新 last_used_at。
    await adminDb.run("UPDATE management_token SET expires_at = ? WHERE user_id = ?", [T0, alice.id]);
    expect((await handleAdmin(req(alice.management_token), deps())).status).toBe(401);
    expect(
      await adminDb.all("SELECT last_used_at FROM management_token WHERE user_id = ?", [alice.id]),
    ).toMatchObject([{ last_used_at: T0 }]);
  });
});

// ---- 备份信封（desktop 06：/admin/export 扩容）------------------------------------

describe("admin export envelope (desktop 06)", () => {
  function reqAs(token: string, method: string, path: string, body?: unknown): Request {
    return new Request(`http://gw${path}`, {
      method,
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const deps = () => ({
    db: adminDb,
    credentials: { adminToken: srvEnv.adminToken },
    encryptionKey: srvEnv.encryptionKey,
    now: () => T0,
  });

  /** 全量种子：七类内容各至少一行（经 SQL 直插以控制哈希列等敏感字段）。 */
  async function seedEnvelope() {
    const cryptoKey = await importEncryptionKey(TEST_ENCRYPTION_KEY);
    const encrypted = await encryptApiKey(cryptoKey, PLAINTEXT_KEY);
    const lgkHash = await sha256Hex("lgk_export-test-secret");
    const lgmHash = await sha256Hex("lgm_export-test-secret");
    const rows: Array<[string, unknown[]]> = [
      ["INSERT INTO provider (id, name, type, enabled, weight, cooldown_failure_threshold, cooldown_ms, created_at, updated_at) VALUES ('prov-1', 'openai-main', 'custom', 1, 2, 5, 120000, ?, ?)", [T0, T0]],
      ["INSERT INTO provider_endpoint (id, provider_id, protocol, base_url) VALUES ('ep-1', 'prov-1', 'openai', 'https://a.test')", []],
      ["INSERT INTO provider_key (id, provider_id, encrypted_key, key_hint, enabled, daily_token_limit, daily_request_limit, created_at, updated_at) VALUES ('pk-1', 'prov-1', ?, 'cret', 1, 1000, 2000, ?, ?)", [encrypted, T0, T0]],
      ["INSERT INTO model_mapping (id, client_model, provider_id, upstream_model, enabled) VALUES ('mm-1', 'm1', 'prov-1', 'gpt-4o', 1)", []],
      // alice = enabled user；root = 停用管理员（导出应保留 enabled 原值）。
      ["INSERT INTO user (id, name, role, enabled, created_at, updated_at) VALUES ('u-alice', 'alice', 'user', 1, ?, ?)", [T0, T0]],
      ["INSERT INTO user (id, name, role, enabled, created_at, updated_at) VALUES ('u-root', 'root', 'administrator', 0, ?, ?)", [T0, T0]],
      ["INSERT INTO management_token (id, user_id, token_hash, key_hint, enabled, created_at, updated_at) VALUES ('mt-1', 'u-alice', ?, 'lgm_', 1, ?, ?)", [lgmHash, T0, T0]],
      ["INSERT INTO access_key (id, user_id, name, key_hash, key_hint, enabled, expires_at, ip_allowlist, daily_token_limit, daily_request_limit, max_concurrency, created_at, updated_at) VALUES ('ak-1', 'u-alice', 'scene', ?, 'cret', 1, 0, '[]', 3000, 4000, 5, ?, ?)", [lgkHash, T0, T0]],
      ["INSERT INTO user_key_grant (id, user_id, provider_key_id, daily_token_limit, daily_request_limit, created_at) VALUES ('gr-1', 'u-alice', 'pk-1', 7000, 8000, ?)", [T0]],
      ["INSERT INTO admin_audit (id, ts, action, target, detail, actor_user_id) VALUES ('au-1', ?, 'provider.create', 'prov-1', '{\"name\":\"openai-main\"}', NULL)", [T0]],
    ];
    for (const [sql, params] of rows) await adminDb.run(sql, params);
    return { encrypted, lgkHash, lgmHash };
  }

  it("exports the versioned envelope: all seven sections, ciphertext in, quotas in, no hashes/plaintext", async () => {
    const { encrypted, lgkHash, lgmHash } = await seedEnvelope();
    const resp = await handleAdmin(reqAs("admin-secret", "GET", "/admin/export"), deps());
    expect(resp.status).toBe(200);
    const body = await resp.text();
    const env = JSON.parse(body) as {
      version: number; exported_at: number;
      providers: Array<Record<string, unknown>>;
      keys: Array<Record<string, unknown>>;
      mappings: unknown[]; users: Array<Record<string, unknown>>;
      grants: Array<Record<string, unknown>>;
      access_keys: Array<Record<string, unknown>>;
      audit: Array<Record<string, unknown>>;
    };

    // 版本信封（恢复脚本据此识别/拒绝旧格式）。
    expect(env.version).toBe(1);
    expect(env.exported_at).toBe(T0);

    // 七类内容齐全。
    expect(env.providers).toHaveLength(1);
    expect(env.providers[0]).toMatchObject({ id: "prov-1", name: "openai-main", cooldown_failure_threshold: 5, cooldown_ms: 120000, endpoints: { openai: "https://a.test" } });
    expect(env.keys).toHaveLength(1);
    expect(env.mappings).toHaveLength(1);
    expect(env.users).toHaveLength(2);
    expect(env.users.find((u) => u.id === "u-root")).toMatchObject({ enabled: 0, role: "administrator" });
    expect(env.grants).toHaveLength(1);
    expect(env.access_keys).toHaveLength(1);
    expect(env.audit).toHaveLength(1);

    // 密文在（encrypted_key 原样）+ 配额在（资产级/授权级）。
    expect(env.keys[0]).toMatchObject({ id: "pk-1", provider_id: "prov-1", encrypted_key: encrypted, daily_token_limit: 1000, daily_request_limit: 2000 });
    expect(env.grants[0]).toMatchObject({ user_id: "u-alice", provider_key_id: "pk-1", daily_token_limit: 7000, daily_request_limit: 8000 });

    // 任何字段不含哈希与明文：整串检 + 敏感列名检。
    expect(body).not.toContain(PLAINTEXT_KEY);
    expect(body).not.toContain("lgk_export-test-secret");
    expect(body).not.toContain("lgm_export-test-secret");
    expect(body).not.toContain(lgkHash);
    expect(body).not.toContain(lgmHash);
    expect(body).not.toContain("key_hash");
    expect(body).not.toContain("token_hash");
    expect(body).not.toContain("token_hint");
  });

  it("keeps export administrator-only (user role 403)", async () => {
    await seedEnvelope();
    // alice 的 lgm_ 哈希在库里——构造有效 lgm_ 需走发放路径；这里直接验角色门。
    const created = await handleAdmin(reqAs("admin-secret", "POST", "/admin/users", { name: "mallory", role: "user" }), deps());
    expect(created.status).toBe(201);
    const mallory = (await created.json()) as { management_token: string };
    expect((await handleAdmin(reqAs(mallory.management_token, "GET", "/admin/export"), deps())).status).toBe(403);
  });
});

describe("built-in web UI static serving (builtin-web 01)", () => {
  let assetsDir: string;

  beforeAll(() => {
    // 临时资产目录（assetsDir 注入缝）：index.html 带标记串，嵌套资产一个。
    assetsDir = mkdtempSync(join(tmpdir(), "lutragate-assets-"));
    writeFileSync(
      join(assetsDir, "index.html"),
      "<!doctype html><html><body>lg-assets-index-marker</body></html>",
    );
    mkdirSync(join(assetsDir, "assets"), { recursive: true });
    writeFileSync(join(assetsDir, "assets", "app.js"), "console.log('lg-assets-js-marker')");
  });

  afterAll(() => {
    rmSync(assetsDir, { recursive: true, force: true });
  });

  function uiApp() {
    return createApp({ env: env(), dbPath: ":memory:", assetsDir });
  }

  it("根路径与嵌套资产返回静态文件；SPA 深链回退 index.html", async () => {
    const app = uiApp();
    const root = await app.request("http://gw/");
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain("lg-assets-index-marker");

    const asset = await app.request("http://gw/assets/app.js");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("lg-assets-js-marker");

    // 前端路由深链（非资产非 API）→ index.html，刷新/深链不 404。
    const deep = await app.request("http://gw/settings/keys");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("lg-assets-index-marker");
  });

  it("API 优先不变式：/v1、/admin、/version、/health 不被 SPA 回退吞掉", async () => {
    const app = uiApp();

    // /v1 鉴权门（JSON 错误，不是 index.html）——含未知子路径。
    const v1 = await app.request("http://gw/v1/models");
    expect(v1.status).toBe(401);
    expect(v1.headers.get("content-type")).toContain("application/json");
    const v1Err = (await v1.json()) as { error: { code: string } };
    expect(v1Err.error.code).toBe("UNAUTHORIZED");

    // 鉴权门先于路由（空库无此 key → 401 UNAUTHORIZED JSON，不是 index.html）。
    const v1Unknown = await app.request("http://gw/v1/nonexistent", {
      headers: { authorization: `Bearer ${LGK}` },
    });
    expect(v1Unknown.headers.get("content-type")).toContain("application/json");
    const v1UnknownBody = (await v1Unknown.json()) as { error: { code: string } };
    expect(v1UnknownBody.error.code).toBe("UNAUTHORIZED");

    // 管理面：裸 /admin 与子路径照旧走 admin 面（401，非 HTML）。
    const bareAdmin = await app.request("http://gw/admin");
    expect(bareAdmin.status).toBe(401);
    expect(bareAdmin.headers.get("content-type")).toContain("application/json");

    // /version 与 /health 仍是 JSON 端点。
    const version = await app.request("http://gw/version");
    expect(version.status).toBe(200);
    expect(version.headers.get("content-type")).toContain("application/json");
    const health = await app.request("http://gw/health");
    expect(health.status).toBe(200);
  });

  it("非 GET 的未知路径仍走 gateway（不回退 index.html），CORS 不变", async () => {
    const app = uiApp();
    const post = await app.request("http://gw/nope", { method: "POST" });
    expect(post.headers.get("content-type")).toContain("application/json");

    const corsResp = await app.request("http://gw/", {
      headers: { origin: "http://localhost:5173" },
    });
    expect(corsResp.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("API 优先不变式的路径变体：编码、重复斜杠、尾斜杠不被 SPA 吞掉", async () => {
    const app = uiApp();
    // %2f 编码的 API 子路径：gateway JSON（401），不是 index.html。
    const encoded = await app.request("http://gw/v1%2fmodels");
    expect(encoded.headers.get("content-type")).toContain("application/json");
    // 重复斜杠变体：gateway JSON，不是 index.html。
    const doubled = await app.request("http://gw//v1/models");
    expect(doubled.headers.get("content-type")).toContain("application/json");
    // 精确端点的尾斜杠：此前走 gateway 兜底回 404 JSON，仍不得变成 index.html。
    const trailing = await app.request("http://gw/version/");
    expect(trailing.headers.get("content-type")).toContain("application/json");
    // Gemini 原生面：/v1beta 是独立路径段，不被 /v1 前缀判定覆盖。
    const gemini = await app.request("http://gw/v1beta/models/gemini-2.0-flash:generateContent");
    expect(gemini.headers.get("content-type")).toContain("application/json");
  });

  it("未开 assetsDir（默认）时静态服务关闭：根路径走 gateway 原行为", async () => {
    const app = createApp({ env: env(), dbPath: ":memory:" });
    const root = await app.request("http://gw/");
    expect(root.status).toBe(401);
    expect(root.headers.get("content-type")).toContain("application/json");
  });

  it("内置 Web 端浏览器 origin：同源放行（走到鉴权），跨域非白名单仍 403", async () => {
    const app = uiApp();
    // 同源 origin（如 LAN IP 直开内置管理端）：CORS 守卫放行 → 落到鉴权 401，而非 403。
    const same = await app.request("http://gw/admin/providers", {
      headers: { origin: "http://gw" },
    });
    expect(same.status).toBe(401);
    expect((await same.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const evil = await app.request("http://gw/admin/providers", {
      headers: { origin: "https://evil.example", "x-admin-token": "admin-secret" },
    });
    expect(evil.status).toBe(403);
  });
});
