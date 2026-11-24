import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Fetcher, LogSink } from "@lutragate/core";
import { createHandler } from "./index";
import { D1LogSink } from "./log-sink";
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

/**
 * 网关准入与凭证生命周期（access-control 02）：worker 全量 handler + D1 +
 * 全部迁移。覆盖 lgk_ 过期（快照判定、时钟注入、复活）、IP 白名单
 * （CF-Connecting-IP 来源、/v1/models 同样受控、拒绝不留痕）、provider 冷却
 * 覆盖与 lgm_ 实时过期 + last_used_at。
 */

const TEST_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const T0 = 1_731_024_000_000;
const WORKER_ENV = {
  DB: env.DB,
  ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  ADMIN_TOKEN: "admin-secret",
};

function db(): D1Database {
  if (!env.DB) throw new Error("D1 binding DB missing");
  return env.DB;
}

/** 可 await 的日志 sink：把 fire-and-forget 的 D1 写收集起来供断言。 */
function trackedSink(): { sink: LogSink; flush: () => Promise<void> } {
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

const okBody = JSON.stringify({ choices: [{ message: { content: "hi" } }] });

interface Fixture {
  rootToken: string;
  aliceId: string;
  aliceToken: string;
  lgk: string;
  lgkId: string;
}

/** 单供应商夹具：p-a 一把 key、m1 映射；alice 被授权。provider 创建参数可注入。 */
async function seedFixture(
  handler: ReturnType<typeof createHandler>,
  providerExtra: Record<string, unknown> = {},
): Promise<Fixture> {
  const admin = (path: string, method: string, token: string, body?: unknown) =>
    handler(
      new Request(`http://gw${path}`, {
        method,
        headers: { "x-admin-token": token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      WORKER_ENV,
    );
  const provResp = await admin("/admin/providers", "POST", "admin-secret", {
    name: "p-a", endpoints: { openai: "https://p-a.test" }, ...providerExtra,
  });
  const provider = (await provResp.json()) as { id: string };
  const keyResp = await admin("/admin/keys", "POST", "admin-secret", { provider_id: provider.id, api_key: "sk-upstream-p-a" });
  const keyId = ((await keyResp.json()) as { id: string }).id;
  await admin("/admin/mappings", "POST", "admin-secret", { client_model: "m1", provider_id: provider.id, upstream_model: "a-up" });

  const rootResp = await admin("/admin/users", "POST", "admin-secret", { name: "root", role: "administrator" });
  const root = (await rootResp.json()) as { management_token: string };
  const aliceResp = await admin("/admin/users", "POST", root.management_token, { name: "alice", role: "user" });
  const alice = (await aliceResp.json()) as { id: string; management_token: string };
  const keyCreate = await admin("/admin/access-keys", "POST", alice.management_token, { name: "scene-1" });
  const created = (await keyCreate.json()) as { id: string; access_key: string };
  await admin(`/admin/users/${alice.id}/grants`, "PUT", root.management_token, { provider_key_ids: [keyId] });

  return {
    rootToken: root.management_token,
    aliceId: alice.id,
    aliceToken: alice.management_token,
    lgk: created.access_key,
    lgkId: created.id,
  };
}

/** 带可变时钟的 handler：过期语义靠 clockNow 推进验证。 */
function gateway(overrides: { fetcher?: Fetcher } = {}) {
  const tracked = trackedSink();
  let clockNow = T0;
  const handler = createHandler({
    fetcher: overrides.fetcher,
    clock: { now: () => clockNow },
    rng: () => 0,
    logSink: tracked.sink,
  });
  const admin = (path: string, method: string, token: string, body?: unknown) =>
    handler(
      new Request(`http://gw${path}`, {
        method,
        headers: { "x-admin-token": token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      WORKER_ENV,
    );
  const v1 = (path: string, headers: Record<string, string> = {}, body?: unknown) =>
    handler(
      new Request(`http://gw${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      WORKER_ENV,
    );
  return { handler, admin, v1, advance: (ms: number) => { clockNow = T0 + ms; }, flush: tracked.flush };
}

async function requestLog(): Promise<Array<Record<string, unknown>>> {
  const { results } = await db().prepare("SELECT * FROM request_log ORDER BY ts, rowid").all<Record<string, unknown>>();
  return results ?? [];
}

beforeAll(async () => {
  const statements = [migrationSql, migration2Sql, migration3Sql, migration4Sql, migration5Sql, migration6Sql, migration7Sql, migration8Sql, migration9Sql, migration10Sql, migration11Sql, migration12Sql, migration13Sql].join(";").split(";").map((s) => s.trim()).filter(Boolean);
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

describe("lgk_ expiry admission (access-control 02)", () => {
  it("expired key → 401; inside the TTL window it still passes (snapshot semantics)", async () => {
    const g = gateway({ fetcher: mockFetcher([new Response(okBody, { status: 200 })]) });
    const f = await seedFixture(g.handler);
    const auth = { authorization: `Bearer ${f.lgk}` };

    // 设 60s 过期；时钟仍在窗口内（快照判定接受 ≤30s 生效延迟的同族语义）。
    expect((await g.admin(`/admin/access-keys/${f.lgkId}`, "PUT", f.aliceToken, { expires_at: T0 + 60_000 })).status).toBe(200);
    expect((await g.v1("/v1/models", auth)).status).toBe(200);
    expect((await g.v1("/v1/chat/completions", auth, { model: "m1", messages: [] })).status).toBe(200);

    // 越过过期点（now ≥ expires_at）→ 401，过期优先于路由（含 /v1/models）。
    g.advance(60_000);
    const expired = await g.v1("/v1/models", auth);
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toMatchObject({ error: { code: "UNAUTHORIZED", message: expect.stringContaining("expired") } });

    // 拒绝不留痕：过期 401 发生在路由前，被拒的 chat 不新增 request_log
    // （此前唯一一行来自窗口内的成功 chat）。
    await g.flush();
    const chatDenied = await g.v1("/v1/chat/completions", auth, { model: "m1", messages: [] });
    expect(chatDenied.status).toBe(401);
    await g.flush();
    const rows = await requestLog();
    expect(rows).toHaveLength(1);
  });

  it("revives via PUT of a future time (no separate unblock endpoint)", async () => {
    const g = gateway({ fetcher: mockFetcher([new Response(okBody, { status: 200 })]) });
    const f = await seedFixture(g.handler);
    const auth = { authorization: `Bearer ${f.lgk}` };

    // 已过期（expires_at 在过去）→ 401；直接 PUT 未来时间即恢复。
    expect((await g.admin(`/admin/access-keys/${f.lgkId}`, "PUT", f.aliceToken, { expires_at: T0 - 1 })).status).toBe(200);
    expect((await g.v1("/v1/models", auth)).status).toBe(401);
    expect((await g.admin(`/admin/access-keys/${f.lgkId}`, "PUT", f.aliceToken, { expires_at: T0 + 3_600_000 })).status).toBe(200);
    expect((await g.v1("/v1/models", auth)).status).toBe(200);
    await g.flush();
  });
});

describe("lgk_ IP allowlist admission (access-control 02)", () => {
  const LIST = ["203.0.113.0/24", "2001:db8::/32"];
  const ip = (value: string) => ({ "cf-connecting-ip": value });

  it("matched IP passes, mismatch → 403 IP_NOT_ALLOWED, across /v1/* incl /v1/models", async () => {
    const g = gateway({ fetcher: mockFetcher([new Response(okBody, { status: 200 })]) });
    const f = await seedFixture(g.handler);
    expect((await g.admin(`/admin/access-keys/${f.lgkId}`, "PUT", f.aliceToken, { ip_allowlist: LIST })).status).toBe(200);
    const auth = { authorization: `Bearer ${f.lgk}` };

    // v4 网段命中、v6 命中、v4 网段外 403。
    expect((await g.v1("/v1/models", { ...auth, ...ip("203.0.113.7") })).status).toBe(200);
    expect((await g.v1("/v1/models", { ...auth, ...ip("2001:db8::9") })).status).toBe(200);
    const denied = await g.v1("/v1/models", { ...auth, ...ip("198.51.100.1") });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: "IP_NOT_ALLOWED" } });
  });

  it("unknown IP (no CF-Connecting-IP) + list set → 403; empty list = unlimited", async () => {
    const g = gateway({ fetcher: mockFetcher([new Response(okBody, { status: 200 })]) });
    const f = await seedFixture(g.handler);
    const auth = { authorization: `Bearer ${f.lgk}` };

    // 未设列表时不限（无 IP 头也放行）。
    expect((await g.v1("/v1/models", auth)).status).toBe(200);

    // 已设列表 + 解析不出 IP → 403（与 admin 面 ALLOWED_IPS 行为一致）。
    expect((await g.admin(`/admin/access-keys/${f.lgkId}`, "PUT", f.aliceToken, { ip_allowlist: LIST })).status).toBe(200);
    expect((await g.v1("/v1/models", auth)).status).toBe(403);

    // 清空列表回到不限。
    expect((await g.admin(`/admin/access-keys/${f.lgkId}`, "PUT", f.aliceToken, { ip_allowlist: [] })).status).toBe(200);
    expect((await g.v1("/v1/models", auth)).status).toBe(200);
    await g.flush();
  });

  it("rejected requests leave no request_log rows", async () => {
    const g = gateway({ fetcher: mockFetcher([new Response(okBody, { status: 200 })]) });
    const f = await seedFixture(g.handler);
    const auth = { authorization: `Bearer ${f.lgk}` };

    expect((await g.admin(`/admin/access-keys/${f.lgkId}`, "PUT", f.aliceToken, { ip_allowlist: LIST })).status).toBe(200);
    expect((await g.v1("/v1/chat/completions", auth, { model: "m1", messages: [] })).status).toBe(403);
    await g.flush();
    expect(await requestLog()).toHaveLength(0);
  });

  it("checks expiry before IP (expired + wrong IP → 401)", async () => {
    const g = gateway();
    const f = await seedFixture(g.handler);
    expect((await g.admin(`/admin/access-keys/${f.lgkId}`, "PUT", f.aliceToken, { expires_at: T0 - 1, ip_allowlist: LIST })).status).toBe(200);
    const resp = await g.v1("/v1/models", { authorization: `Bearer ${f.lgk}`, "cf-connecting-ip": "198.51.100.1" });
    expect(resp.status).toBe(401); // 过期优先于 IP
    await g.flush();
  });
});

describe("provider cooldown override on the hot path (access-control 02)", () => {
  it("threshold override 1: first failure cools the only key → 503 after a single upstream call", async () => {
    const fetcher = mockFetcher([new Response("boom", { status: 500 })]);
    const g = gateway({ fetcher });
    const f = await seedFixture(g.handler, { cooldown_failure_threshold: 1 });
    const auth = { authorization: `Bearer ${f.lgk}` };

    // 覆盖阈值 1：首次失败即冷却唯一 key → 第二轮 selectChannel 无候选 → 503。
    const overridden = await g.v1("/v1/chat/completions", auth, { model: "m1", messages: [] });
    expect(overridden.status).toBe(503);
    await expect(overridden.json()).resolves.toMatchObject({ error: { code: "NO_CHANNEL" } });
    expect(fetcher.requests).toHaveLength(1);
    await g.flush();
    expect(await requestLog()).toHaveLength(1); // 503 仍写日志（真实代理请求）
  });

  it("0 keeps the global default (3 attempts → 502)", async () => {
    const fetcher = mockFetcher([new Response("boom", { status: 500 })]);
    const g = gateway({ fetcher });
    const f = await seedFixture(g.handler, { cooldown_failure_threshold: 0, cooldown_ms: 0 });

    const resp = await g.v1("/v1/chat/completions", { authorization: `Bearer ${f.lgk}` }, { model: "m1", messages: [] });
    expect(resp.status).toBe(502);
    expect(fetcher.requests).toHaveLength(3);
    await g.flush();
  });
});

describe("lgm_ lifecycle (access-control 02)", () => {
  it("virtual admin writes no last_used_at; expired lgm_ → 401 realtime; valid hit updates last_used_at", async () => {
    const g = gateway();
    // 引导虚拟管理员（尚无任何用户）：无 token 行，天然不写 last_used_at。
    expect((await g.admin("/admin/providers", "GET", "admin-secret")).status).toBe(200);
    const { results } = await db().prepare("SELECT COUNT(*) AS n FROM management_token").all<{ n: number }>();
    expect(results[0]!.n).toBe(0);

    const f = await seedFixture(g.handler);
    // 过去时间（epoch 1）→ 实时 401（admin-auth WHERE 条件，无快照延迟）。
    const expiredReset = await g.admin(`/admin/users/${f.aliceId}/token`, "POST", f.rootToken, { expires_at: 1 });
    expect(expiredReset.status).toBe(200);
    const expiredToken = ((await expiredReset.json()) as { management_token: string }).management_token;
    expect((await g.admin("/admin/me", "GET", expiredToken)).status).toBe(401);

    // 未来时间 → 200，命中后 last_used_at 被内联更新（> 0；管理面时钟非注入）。
    const validReset = await g.admin(`/admin/users/${f.aliceId}/token`, "POST", f.rootToken, { expires_at: Date.now() + 3_600_000 });
    const validToken = ((await validReset.json()) as { management_token: string }).management_token;
    expect((await g.admin("/admin/me", "GET", validToken)).status).toBe(200);
    const rows = (await db().prepare("SELECT last_used_at FROM management_token WHERE user_id = ?").bind(f.aliceId).all<{ last_used_at: number }>()).results;
    expect(rows[0]!.last_used_at).toBeGreaterThan(0);
    // lgm_ 不受 IP 白名单限制（仅 lgk_ 有白名单）：无 IP 头照常通过。
    expect((await g.admin("/admin/me", "GET", validToken)).status).toBe(200);
  });
});
