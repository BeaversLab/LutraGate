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
 * 网关热路径切换（multi-user ticket 04）：唯一服务端接缝 = worker 全量
 * handler + 内存 D1 + 全部迁移。覆盖 lgk_ 鉴权、按用户授权路由、/v1/models
 * 收敛、日志归属与缓存失效。
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
  keyA: string;
  keyB: string;
  providerA: string;
  providerB: string;
}

async function admin(
  handler: ReturnType<typeof createHandler>,
  path: string,
  method: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return handler(
    new Request(`http://gw${path}`, {
      method,
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    WORKER_ENV,
  );
}

/**
 * 双供应商夹具：p-a / p-b 各一把 key；m1 双映射，m2 仅 p-b；alice 仅被授权
 * p-a 的 key。所有写都走全量 handler（共享配置缓存与失效）。
 */
async function seedFixture(handler: ReturnType<typeof createHandler>): Promise<Fixture> {
  const makeProvider = async (name: string, models: Array<[string, string]>) => {
    const resp = await admin(handler, "/admin/providers", "POST", "admin-secret", {
      name, endpoints: { openai: `https://${name}.test` },
    });
    const { id } = (await resp.json()) as { id: string };
    const keyResp = await admin(handler, "/admin/keys", "POST", "admin-secret", {
      provider_id: id, api_key: `sk-upstream-${name}`,
    });
    const keyId = ((await keyResp.json()) as { id: string }).id;
    for (const [clientModel, upstreamModel] of models) {
      await admin(handler, "/admin/mappings", "POST", "admin-secret", {
        client_model: clientModel, provider_id: id, upstream_model: upstreamModel,
      });
    }
    return { id, keyId };
  };
  const a = await makeProvider("p-a", [["m1", "a-up"]]);
  const b = await makeProvider("p-b", [["m1", "b-up"], ["m2", "b-up2"]]);

  // 引导建 root → root 建 alice → alice 自建 lgk_ → root 只授权 p-a 的 key。
  const rootResp = await admin(handler, "/admin/users", "POST", "admin-secret", { name: "root", role: "administrator" });
  const root = (await rootResp.json()) as { management_token: string };
  const aliceResp = await admin(handler, "/admin/users", "POST", root.management_token, { name: "alice", role: "user" });
  const alice = (await aliceResp.json()) as { id: string; management_token: string };
  const keyResp = await admin(handler, "/admin/access-keys", "POST", alice.management_token, { name: "scene-1" });
  const created = (await keyResp.json()) as { id: string; access_key: string };
  await admin(handler, `/admin/users/${alice.id}/grants`, "PUT", root.management_token, { provider_key_ids: [a.keyId] });

  return {
    rootToken: root.management_token,
    aliceId: alice.id,
    aliceToken: alice.management_token,
    lgk: created.access_key,
    lgkId: created.id,
    keyA: a.keyId,
    keyB: b.keyId,
    providerA: a.id,
    providerB: b.id,
  };
}

function gateway(overrides: { fetcher?: Fetcher } = {}) {
  const tracked = trackedSink();
  const handler = createHandler({
    fetcher: overrides.fetcher,
    clock: { now: () => T0 },
    rng: () => 0, // deterministic: first candidate
    logSink: tracked.sink,
  });
  return { handler, flush: tracked.flush };
}

function v1(
  handler: ReturnType<typeof createHandler>,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Response> {
  return handler(
    new Request(`http://gw${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    WORKER_ENV,
  );
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

describe("gateway lgk_ authentication (multi-user 04)", () => {
  it("forwards with the authorized provider key and logs attribution", async () => {
    const { handler, flush } = gateway({ fetcher: mockFetcher([new Response(okBody, { status: 200 })]) });
    const f = await seedFixture(handler);

    const resp = await v1(handler, "/v1/chat/completions", { authorization: `Bearer ${f.lgk}` }, { model: "m1", messages: [] });
    expect(resp.status).toBe(200);
    await flush();

    // 上游用的是被授权的那把 provider key（p-a），不是 p-b。
    // （fetcher 由 mockFetcher 共享——这里直接检查日志中的归属与渠道。）
    const rows = await requestLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      client_model: "m1",
      provider_id: f.providerA,
      key_id: f.keyA,
      user_id: f.aliceId,
      access_key_id: f.lgkId,
      status: 200,
    });
  });

  it("uses exactly the authorized key upstream (not the other provider's)", async () => {
    const fetcher = mockFetcher([new Response(okBody, { status: 200 })]);
    const { handler, flush } = gateway({ fetcher });
    const f = await seedFixture(handler);

    await v1(handler, "/v1/chat/completions", { authorization: `Bearer ${f.lgk}` }, { model: "m1" });
    await flush(); // fire-and-forget 日志写完再结束（隔离存储快照要求）
    expect(fetcher.requests).toHaveLength(1);
    expect(fetcher.requests[0]!.url).toBe("https://p-a.test/v1/chat/completions");
    expect(fetcher.requests[0]!.headers.get("authorization")).toBe("Bearer sk-upstream-p-a");
  });

  it("answers 503 NO_CHANNEL when unauthorized, then routes immediately after the grant lands", async () => {
    const { handler, flush } = gateway({ fetcher: mockFetcher([new Response(okBody, { status: 200 })]) });
    const f = await seedFixture(handler);

    // m2 只在 p-b 上——alice 未被授权 p-b 的 key → 无候选 → 现有 503。
    const denied = await v1(handler, "/v1/chat/completions", { authorization: `Bearer ${f.lgk}` }, { model: "m2" });
    expect(denied.status).toBe(503);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: "NO_CHANNEL" } });
    await flush();
    // 错误路径日志同样带归属。
    const rows = await requestLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 503,
      error_type: "NO_CHANNEL:ALL_DISABLED",
      user_id: f.aliceId,
      access_key_id: f.lgkId,
    });

    // 授权 p-b 的 key（同 handler 实例，管理面写已失效缓存）→ 立即可路由。
    const put = await admin(handler, `/admin/users/${f.aliceId}/grants`, "PUT", f.rootToken, {
      provider_key_ids: [f.keyA, f.keyB],
    });
    expect(put.status).toBe(200);
    const ok = await v1(handler, "/v1/chat/completions", { authorization: `Bearer ${f.lgk}` }, { model: "m2" });
    expect(ok.status).toBe(200);
    await flush();
  });

  it("authenticates via any candidate header when a client sends multiple credentials", async () => {
    // 真实场景（quota 调试实录）：Claude Code 同时携带 x-api-key（环境残留
    // 的外部 key）+ Authorization Bearer（lgk_）。取第一个头就 401 会误伤——
    // 逐个候选尝试，任一命中即通过。
    const { handler } = gateway({ fetcher: mockFetcher([new Response(okBody, { status: 200 })]) });
    const f = await seedFixture(handler);

    const auth = { "x-api-key": "sk-ant-api03-stale-external-key", authorization: `Bearer ${f.lgk}` };
    const resp = await v1(handler, "/v1/models", auth);
    expect(resp.status).toBe(200);

    // 全部候选都无效时仍是 401。
    const bothBad = await v1(handler, "/v1/models", {
      "x-api-key": "sk-ant-api03-stale-external-key",
      authorization: "Bearer lgk_wrong",
    });
    expect(bothBad.status).toBe(401);
  });

  it("converges /v1/models to fully authorized paths only", async () => {
    const { handler } = gateway();
    const f = await seedFixture(handler);
    const auth = { authorization: `Bearer ${f.lgk}` };

    // 授权仅 p-a：m1（p-a 可达）在列，m2（仅 p-b）不在。
    const before = (await (await v1(handler, "/v1/models", auth)).json()) as { data: Array<{ id: string }> };
    expect(before.data.map((m) => m.id)).toEqual(["m1"]);

    // 授权 p-b 后 m2 出现。
    await admin(handler, `/admin/users/${f.aliceId}/grants`, "PUT", f.rootToken, { provider_key_ids: [f.keyA, f.keyB] });
    const after = (await (await v1(handler, "/v1/models", auth)).json()) as { data: Array<{ id: string }> };
    expect(after.data.map((m) => m.id)).toEqual(["m1", "m2"]);

    // 被授权但禁用上游 key → 仅靠该 key 可达的模型消失（m2 只在 p-b 上）。
    await admin(handler, `/admin/keys/${f.keyB}`, "PUT", f.rootToken, { enabled: false });
    const disabled = (await (await v1(handler, "/v1/models", auth)).json()) as { data: Array<{ id: string }> };
    expect(disabled.data.map((m) => m.id)).toEqual(["m1"]);
  });

  it("rejects missing, wrong, disabled and disabled-user keys with 401", async () => {
    const { handler } = gateway();
    const f = await seedFixture(handler);

    expect((await v1(handler, "/v1/models")).status).toBe(401);
    expect((await v1(handler, "/v1/models", { authorization: "Bearer lgk_wrong" })).status).toBe(401);
    expect((await v1(handler, "/v1/models", { authorization: "Bearer not-even-a-key" })).status).toBe(401);

    // 禁用访问 key → 同 isolate 立即 401（管理面写失效缓存）。
    await admin(handler, `/admin/access-keys/${f.lgkId}`, "PUT", f.aliceToken, { enabled: false });
    expect((await v1(handler, "/v1/models", { authorization: `Bearer ${f.lgk}` })).status).toBe(401);

    // 重新启用 key、禁用用户 → 其 key 随之失效。
    await admin(handler, `/admin/access-keys/${f.lgkId}`, "PUT", f.aliceToken, { enabled: true });
    expect((await v1(handler, "/v1/models", { authorization: `Bearer ${f.lgk}` })).status).toBe(200);
    await admin(handler, `/admin/users/${f.aliceId}`, "PUT", f.rootToken, { enabled: false });
    expect((await v1(handler, "/v1/models", { authorization: `Bearer ${f.lgk}` })).status).toBe(401);
  });

  it("accepts lgk_ via the OpenAI/Anthropic/Gemini auth headers and ?key=", async () => {
    const { handler } = gateway();
    const f = await seedFixture(handler);

    expect((await v1(handler, "/v1/models", { "x-api-key": f.lgk })).status).toBe(200);
    expect((await v1(handler, "/v1/models", { "x-goog-api-key": f.lgk })).status).toBe(200);
    expect((await v1(handler, `/v1/models?key=${encodeURIComponent(f.lgk)}`)).status).toBe(200);
    // Bearer 形式仍可用；lgm_ 串号不行（哈希集合不相交）。
    expect((await v1(handler, "/v1/models", { authorization: `Bearer ${f.lgk}` })).status).toBe(200);
    expect((await v1(handler, "/v1/models", { authorization: `Bearer ${f.aliceToken}` })).status).toBe(401);
  });

  it("keeps the planes mutually exclusive: lgk_ never authenticates /admin", async () => {
    const { handler } = gateway();
    const f = await seedFixture(handler);
    const resp = await handler(
      new Request("http://gw/admin/providers", { headers: { "x-admin-token": f.lgk } }),
      WORKER_ENV,
    );
    expect(resp.status).toBe(401);
  });

  it("lists own grants and reachable models on GET /admin/me/grants", async () => {
    const { handler } = gateway();
    const f = await seedFixture(handler);

    const resp = await admin(handler, "/admin/me/grants", "GET", f.aliceToken);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      user_id: string;
      grants: Array<{ provider_key_id: string; provider_name: string }>;
      models: string[];
    };
    expect(body.user_id).toBe(f.aliceId);
    expect(body.grants.map((g) => g.provider_key_id)).toEqual([f.keyA]);
    expect(body.grants[0]).toMatchObject({ provider_name: "p-a" });
    expect(body.models).toEqual(["m1"]); // 与 /v1/models 同一可达性算法
  });
});
