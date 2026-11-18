import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { handleAdmin, SqlConfigStore } from "@lutragate/core";
import { D1AdminDb } from "./d1";
import type { Fetcher } from "@lutragate/core";
import { createHandler } from "./index";
import { decryptApiKey, importEncryptionKey } from "@lutragate/core";
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

// 32-byte zero key in base64 (test only).
const TEST_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ADMIN_ENV = {
  DB: env.DB,
  ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  ADMIN_TOKEN: "admin-secret",
};
const T0 = 1_731_024_000_000;

function db(): D1Database {
  if (!env.DB) throw new Error("D1 binding DB missing");
  return env.DB;
}

function adminReq(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://gw${path}`, {
    method,
    headers: {
      "x-admin-token": "admin-secret",
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface AdminEnvLike {
  DB?: D1Database;
  ENCRYPTION_KEY?: string;
  ADMIN_TOKEN?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}

function adminDeps(envLike: AdminEnvLike = ADMIN_ENV, withNow = false, testFetcher?: Fetcher) {
  return {
    db: new D1AdminDb(envLike.DB as D1Database),
    ...(testFetcher ? { testFetcher } : {}),
    credentials: {
      adminToken: envLike.ADMIN_TOKEN,
      cfAccessClientId: envLike.CF_ACCESS_CLIENT_ID,
      cfAccessClientSecret: envLike.CF_ACCESS_CLIENT_SECRET,
    },
    ...(envLike.ENCRYPTION_KEY ? { encryptionKey: envLike.ENCRYPTION_KEY } : {}),
    ...(withNow ? { now: () => T0 } : {}),
  };
}

async function callAdmin(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handleAdmin(adminReq(method, path, body, headers), adminDeps(ADMIN_ENV, true));
}

/** 以某用户的 lgm_ 管理 token 发起管理面请求。 */
async function callAs(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return handleAdmin(
    new Request(`http://gw${path}`, {
      method,
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    adminDeps(ADMIN_ENV, true),
  );
}

beforeAll(async () => {
  const statements = [migrationSql, migration2Sql, migration3Sql, migration4Sql, migration5Sql, migration6Sql, migration7Sql, migration8Sql, migration9Sql, migration10Sql, migration11Sql, migration12Sql].join(";").split(";").map((s) => s.trim()).filter(Boolean);
  await db().batch(statements.map((s) => db().prepare(s)));
});

beforeEach(async () => {
  await db().batch([
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

async function createProvider(name = "p-a"): Promise<{ id: string }> {
  const resp = await callAdmin("POST", "/admin/providers", { name, endpoints: { openai: `https://${name}.test` } });
  expect(resp.status).toBe(201);
  return (await resp.json()) as { id: string };
}

describe("admin auth (PRD F5.1-F5.3)", () => {
  it("rejects requests without admin credentials", async () => {
    const resp = await handleAdmin(
      new Request("http://gw/admin/providers"),
      adminDeps(),
    );
    expect(resp.status).toBe(401);
  });

  it("rejects a wrong admin token with the unified error structure", async () => {
    const resp = await handleAdmin(
      new Request("http://gw/admin/providers", { headers: { "x-admin-token": "wrong" } }),
      adminDeps(),
    );
    expect(resp.status).toBe(401);
    await expect(resp.json()).resolves.toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("rejects the gateway bearer token (token-system isolation)", async () => {
    const resp = await handleAdmin(
      new Request("http://gw/admin/providers", {
        headers: { authorization: "Bearer gateway-secret" },
      }),
      adminDeps(),
    );
    expect(resp.status).toBe(401);
  });

  it("returns 500 when no admin auth is configured", async () => {
    const resp = await handleAdmin(new Request("http://gw/admin/providers"), adminDeps({ DB: env.DB }));
    expect(resp.status).toBe(500);
  });

  it("prefers Cloudflare Access service tokens when configured", async () => {
    const accessEnv = {
      DB: env.DB,
      CF_ACCESS_CLIENT_ID: "cid",
      CF_ACCESS_CLIENT_SECRET: "csecret",
    };
    // X-Admin-Token is not accepted in Access mode.
    const tokenResp = await handleAdmin(
      new Request("http://gw/admin/providers", { headers: { "x-admin-token": "admin-secret" } }),
      adminDeps(accessEnv),
    );
    expect(tokenResp.status).toBe(401);

    const ok = await handleAdmin(
      new Request("http://gw/admin/providers", {
        headers: { "cf-access-client-id": "cid", "cf-access-client-secret": "csecret" },
      }),
      adminDeps(accessEnv),
    );
    expect(ok.status).toBe(200);
  });
});

describe("admin CORS (spec §3.5)", () => {
  it("answers allowed-origin preflights with 204 + CORS headers", async () => {
    const resp = await handleAdmin(
      new Request("http://gw/admin/providers", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" },
      }),
      adminDeps(),
    );
    expect(resp.status).toBe(204);
    expect(resp.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(resp.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  it("allows the tauri origin and rejects non-local origins with 403", async () => {
    const tauri = await handleAdmin(
      new Request("http://gw/admin/providers", { headers: { origin: "tauri://localhost", "x-admin-token": "admin-secret" } }),
      adminDeps(),
    );
    expect(tauri.status).toBe(200);
    expect(tauri.headers.get("access-control-allow-origin")).toBe("tauri://localhost");

    const evil = await handleAdmin(
      new Request("http://gw/admin/providers", { headers: { origin: "https://evil.example", "x-admin-token": "admin-secret" } }),
      adminDeps(),
    );
    expect(evil.status).toBe(403);
  });

  it("serves non-browser clients without an Origin header", async () => {
    const resp = await callAdmin("GET", "/admin/providers");
    expect(resp.status).toBe(200);
  });
});

describe("providers CRUD", () => {
  it("creates, lists, updates and deletes", async () => {
    const { id } = await createProvider();

    const list = await callAdmin("GET", "/admin/providers");
    const providers = (await list.json()) as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ id, name: "p-a", enabled: 1, weight: 1 });

    const updated = await callAdmin("PUT", `/admin/providers/${id}`, { weight: 5, enabled: false });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id, weight: 5, enabled: false });

    const deleted = await callAdmin("DELETE", `/admin/providers/${id}`);
    expect(deleted.status).toBe(200);
    const after = await callAdmin("GET", "/admin/providers");
    expect(((await after.json()) as unknown[]).length).toBe(0);
  });

  it("returns 404 on update/delete of missing ids and 400 on invalid input", async () => {
    expect((await callAdmin("PUT", "/admin/providers/V1StGXR8_Z5jdHi6B-myZ", { name: "x" })).status).toBe(404);
    expect((await callAdmin("DELETE", "/admin/providers/V1StGXR8_Z5jdHi6B-myZ")).status).toBe(404);
    expect((await callAdmin("POST", "/admin/providers", { name: "", endpoints: { openai: "nope" } })).status).toBe(400);
  });
});

describe("keys CRUD", () => {
  it("encrypts keys server-side and never returns key material", async () => {
    const { id: providerId } = await createProvider();
    const created = await callAdmin("POST", "/admin/keys", {
      provider_id: providerId,
      api_key: "sk-super-secret-abcd",
    });
    expect(created.status).toBe(201);
    const key = (await created.json()) as Record<string, unknown>;
    expect(key.key_hint).toBe("abcd");
    expect(JSON.stringify(key)).not.toContain("sk-super-secret");
    expect(JSON.stringify(key)).not.toContain("encrypted");

    // DB row is ciphertext, decryptable with the encryption key.
    const row = await db()
      .prepare("SELECT encrypted_key FROM provider_key WHERE id = ?")
      .bind(key.id as string)
      .first<{ encrypted_key: string }>();
    expect(row!.encrypted_key).not.toContain("sk-super-secret");
    const cryptoKey = await importEncryptionKey(TEST_ENCRYPTION_KEY);
    await expect(decryptApiKey(cryptoKey, row!.encrypted_key)).resolves.toBe("sk-super-secret-abcd");

    // Listing is redacted too.
    const list = await callAdmin("GET", "/admin/keys");
    const body = await list.text();
    expect(body).not.toContain("encrypted");
    expect(body).not.toContain("sk-super-secret");
  });

  it("rejects keys for unknown providers and PUT only toggles enabled", async () => {
    const resp = await callAdmin("POST", "/admin/keys", {
      provider_id: "V1StGXR8_Z5jdHi6B-myZ",
      api_key: "sk-xxxx",
    });
    expect(resp.status).toBe(404);

    const { id: providerId } = await createProvider();
    const { id: keyId } = await (await callAdmin("POST", "/admin/keys", {
      provider_id: providerId,
      api_key: "sk-yyyy",
    })).json() as { id: string };
    const updated = await callAdmin("PUT", `/admin/keys/${keyId}`, { enabled: false });
    expect(await updated.json()).toMatchObject({ id: keyId, enabled: false });
  });

  it("fails loudly when ENCRYPTION_KEY is not configured", async () => {
    const { id: providerId } = await createProvider();
    const resp = await handleAdmin(
      adminReq("POST", "/admin/keys", { provider_id: providerId, api_key: "sk-zzzz" }),
      adminDeps({ DB: env.DB, ADMIN_TOKEN: "admin-secret" }),
    );
    expect(resp.status).toBe(500);
  });
});

describe("mappings CRUD", () => {
  it("creates, updates and deletes mappings", async () => {
    const { id: providerId } = await createProvider();
    const created = await callAdmin("POST", "/admin/mappings", {
      client_model: "m1",
      provider_id: providerId,
      upstream_model: "a-up",
    });
    expect(created.status).toBe(201);
    const mapping = (await created.json()) as Record<string, unknown>;

    const updated = await callAdmin("PUT", `/admin/mappings/${mapping.id}`, { upstream_model: "a-up-2" });
    expect(await updated.json()).toMatchObject({ upstream_model: "a-up-2" });

    expect((await callAdmin("DELETE", `/admin/mappings/${mapping.id}`)).status).toBe(200);
  });

  it("returns 409 on duplicate (client_model, provider_id)", async () => {
    const { id: providerId } = await createProvider();
    await callAdmin("POST", "/admin/mappings", { client_model: "m1", provider_id: providerId, upstream_model: "a-up" });
    const dup = await callAdmin("POST", "/admin/mappings", { client_model: "m1", provider_id: providerId, upstream_model: "b-up" });
    expect(dup.status).toBe(409);
    await expect(dup.json()).resolves.toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("rejects PUT repointing to a nonexistent provider", async () => {
    const { id: providerId } = await createProvider();
    const { id: mappingId } = await (await callAdmin("POST", "/admin/mappings", {
      client_model: "m1", provider_id: providerId, upstream_model: "a-up",
    })).json() as { id: string };
    const resp = await callAdmin("PUT", `/admin/mappings/${mappingId}`, {
      provider_id: "V1StGXR8_Z5jdHi6B-myZ",
    });
    expect(resp.status).toBe(404);
  });

  it("cascades provider deletion to keys and mappings (FK ON DELETE CASCADE)", async () => {
    const { id: providerId } = await createProvider();
    await callAdmin("POST", "/admin/keys", { provider_id: providerId, api_key: "sk-casc-aaaa" });
    await callAdmin("POST", "/admin/mappings", { client_model: "m1", provider_id: providerId, upstream_model: "a-up" });

    expect((await callAdmin("DELETE", `/admin/providers/${providerId}`)).status).toBe(200);
    const keys = await db().prepare("SELECT COUNT(*) AS n FROM provider_key").first<{ n: number }>();
    const mappings = await db().prepare("SELECT COUNT(*) AS n FROM model_mapping").first<{ n: number }>();
    expect(keys!.n).toBe(0);
    expect(mappings!.n).toBe(0);
  });
});

describe("key-level connectivity test (server-side)", () => {
  it("decrypts the key and returns the upstream outcome with a default model", async () => {
    const { id: providerId } = await createProvider();
    const key = await (await callAdmin("POST", "/admin/keys", {
      provider_id: providerId,
      api_key: "sk-real-key-9876",
    })).json() as { id: string };
    await callAdmin("POST", "/admin/mappings", { client_model: "m1", provider_id: providerId, upstream_model: "a-up" });

    const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const testFetcher: Fetcher = {
      async fetch(req) {
        seen.push({ url: req.url, auth: req.headers.get("authorization"), body: await new Response(req.body).json() });
        return new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 });
      },
    };
    const resp = await handleAdmin(
      adminReq("POST", `/admin/keys/${key.id}/test`),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(resp.status).toBe(200);
    const outcome = (await resp.json()) as { ok: boolean; model: string; error?: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("Incorrect API key");
    expect(outcome.model).toBe("a-up"); // 默认取该供应商映射的 upstream_model
    expect(seen[0]!.url).toBe("https://p-a.test/v1/chat/completions");
    expect(seen[0]!.auth).toBe("Bearer sk-real-key-9876"); // 服务端解密后注入
    expect((seen[0]!.body as { max_tokens: number }).max_tokens).toBe(1);
  });

  it("returns 404 for unknown keys and 500 without ENCRYPTION_KEY", async () => {
    const noopFetcher: Fetcher = { fetch: async () => new Response("{}") };
    const missing = await handleAdmin(
      adminReq("POST", "/admin/keys/V1StGXR8_Z5jdHi6B-myZ/test"),
      adminDeps(ADMIN_ENV, false, noopFetcher),
    );
    expect(missing.status).toBe(404);

    const { id: providerId } = await createProvider();
    const key = await (await callAdmin("POST", "/admin/keys", {
      provider_id: providerId, api_key: "sk-1234",
    })).json() as { id: string };
    const noKey = await handleAdmin(
      adminReq("POST", `/admin/keys/${key.id}/test`),
      adminDeps({ DB: env.DB, ADMIN_TOKEN: "admin-secret" }, false, noopFetcher),
    );
    expect(noKey.status).toBe(500);
  });
});

describe("provider model discovery (model-discovery 01)", () => {
  it("decrypts a key, GETs the upstream models list and returns sorted unique ids", async () => {
    const { id: providerId } = await createProvider();
    await callAdmin("POST", "/admin/keys", { provider_id: providerId, api_key: "sk-models-key" });

    const seen: Array<{ url: string; method: string; auth: string | null }> = [];
    const testFetcher: Fetcher = {
      async fetch(req) {
        seen.push({ url: req.url, method: req.method, auth: req.headers.get("authorization") });
        return new Response(
          JSON.stringify({ data: [{ id: "glm-4.6" }, { id: "glm-4.5" }, { id: "glm-4.6" }, { id: "" }] }),
          { status: 200 },
        );
      },
    };
    const resp = await handleAdmin(
      adminReq("GET", `/admin/providers/${providerId}/models`),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { protocol: string; models: string[] };
    expect(body).toEqual({ provider_id: providerId, protocol: "openai", models: ["glm-4.5", "glm-4.6"] });
    expect(seen[0]!.url).toBe("https://p-a.test/v1/models");
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.auth).toBe("Bearer sk-models-key");
  });

  it("keeps only chat-capable models when the upstream list carries capability metadata", async () => {
    const { id: providerId } = await createProvider();
    await callAdmin("POST", "/admin/keys", { provider_id: providerId, api_key: "sk-meta-key" });
    const testFetcher: Fetcher = {
      async fetch() {
        return new Response(JSON.stringify({
          data: [
            // 输出模态明确：文本 → 对话类（含视觉理解：输入图像、输出文本）。
            { id: "doubao-seed-2.1-pro", modalities: { input: ["text", "image"], output: ["text"] } },
            // 输出模态明确：图像/视频/3D/嵌入 → 剔除。
            { id: "seedream-image", modalities: { output: ["image"] } },
            { id: "seedance-video", output_modalities: ["video"] },
            { id: "embed-derived", output_modalities: ["embedding"] },
            // 无模态字段 → 看任务类型：text_to_video / text_embedding 剔除。
            { id: "video-gen", task_type: "text_to_video" },
            { id: "embed", task_types: ["TextEmbedding"] },
            // 混合任务：任一 chat 类即保留。
            { id: "hybrid", task_types: ["TextToImage", "Chat"] },
            // 领域 Embedding → 剔除。
            { id: "domain-embed", domain: "Embedding" },
            // 无任何元数据（纯 {id} 形，如智谱）→ 保留。
            { id: "glm-4.6" },
          ],
        }), { status: 200 });
      },
    };
    const resp = await handleAdmin(
      adminReq("GET", `/admin/providers/${providerId}/models`),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { models: string[] };
    expect(body.models).toEqual(["doubao-seed-2.1-pro", "glm-4.6", "hybrid"]);
  });

  it("falls back across protocol endpoints and 502s when all fail", async () => {
    const resp = await createProvider();
    const { id: providerId } = resp;
    await callAdmin("POST", "/admin/keys", { provider_id: providerId, api_key: "sk-x" });
    await callAdmin("PUT", `/admin/providers/${providerId}`, {
      endpoints: { openai: "https://p-a.test", anthropic: "https://p-a.test/anthropic" },
    });

    const failing: Fetcher = { fetch: async () => new Response("nope", { status: 500 }) };
    const result = await handleAdmin(
      adminReq("GET", `/admin/providers/${providerId}/models`),
      adminDeps(ADMIN_ENV, false, failing),
    );
    expect(result.status).toBe(502);
    const errBody = (await result.json()) as { error: { message: string } };
    expect(errBody.error.message).toContain("openai");
    expect(errBody.error.message).toContain("anthropic");
  });

  it("returns 404 for unknown providers and 400 without an enabled key", async () => {
    const noop: Fetcher = { fetch: async () => new Response("{}") };
    const unknown = await handleAdmin(
      adminReq("GET", "/admin/providers/V1StGXR8_Z5jdHi6B-myZ/models"),
      adminDeps(ADMIN_ENV, false, noop),
    );
    expect(unknown.status).toBe(404);

    const { id: providerId } = await createProvider();
    const noKey = await handleAdmin(
      adminReq("GET", `/admin/providers/${providerId}/models`),
      adminDeps(ADMIN_ENV, false, noop),
    );
    expect(noKey.status).toBe(400); // 有端点但无启用 Key
  });
});

describe("provider usage quota (provider-usage 01/04, key-level)", () => {
  /** 智谱形态 fixture：新套餐 2 个 TOKENS_LIMIT（5h + 周）+ 1 个 TIME_LIMIT（MCP 月）。 */
  function zhipuFixture() {
    return {
      code: 200,
      msg: "操作成功",
      success: true,
      data: {
        level: "pro",
        limits: [
          {
            type: "TOKENS_LIMIT",
            percentage: 42,
            nextResetTime: 1_770_000_000_000,
          },
          {
            type: "TOKENS_LIMIT",
            percentage: 12,
            nextResetTime: 1_770_050_000_000,
          },
          {
            type: "TIME_LIMIT",
            percentage: 7,
            currentValue: 72,
            usage: 1000,
          },
        ],
      },
    };
  }

  async function createZhipuProvider(name = "zhipu-a"): Promise<{ id: string }> {
    const resp = await callAdmin("POST", "/admin/providers", {
      name,
      type: "zhipu-coding",
      endpoints: { openai: "https://open.bigmodel.cn/api/coding/paas/v4" },
    });
    expect(resp.status).toBe(201);
    return (await resp.json()) as { id: string };
  }

  async function createZhipuKey(providerId: string, apiKey = "sk-zhipu-key"): Promise<{ id: string }> {
    const resp = await callAdmin("POST", "/admin/keys", { provider_id: providerId, api_key: apiKey });
    expect(resp.status).toBe(201);
    return (await resp.json()) as { id: string };
  }

  it("decrypts the key, GETs the zhipu quota endpoint with a bare token and normalizes windows", async () => {
    const { id: providerId } = await createZhipuProvider();
    const { id: keyId } = await createZhipuKey(providerId);

    const seen: Array<{ url: string; method: string; auth: string | null }> = [];
    const testFetcher: Fetcher = {
      async fetch(req) {
        seen.push({ url: req.url, method: req.method, auth: req.headers.get("authorization") });
        return new Response(JSON.stringify(zhipuFixture()), { status: 200 });
      },
    };
    const resp = await handleAdmin(
      adminReq("GET", `/admin/keys/${keyId}/usage`),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      key_id: string;
      provider_type: string;
      plan?: string;
      windows: Array<{ key: string; label: string; percentage: number; reset_at?: number; absolute?: string }>;
      fetched_at: number;
    };
    expect(body.key_id).toBe(keyId);
    expect(body.provider_type).toBe("zhipu-coding");
    expect(body.plan).toBe("pro");
    expect(body.windows).toEqual([
      { key: "five_hour", label: "5 小时", percentage: 42, reset_at: 1_770_000_000_000 },
      { key: "weekly", label: "本周", percentage: 12, reset_at: 1_770_050_000_000 },
      { key: "mcp_monthly", label: "MCP（月）", percentage: 7 },
    ]);
    expect(typeof body.fetched_at).toBe("number");
    // 用量端点只看主机，路径固定 /api/monitor/usage/quota/limit（不随 base_url 路径走）；
    // 鉴权 = 裸 token，无 Bearer 前缀（官方插件逐字用法）。
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.auth).toBe("sk-zhipu-key");
  });

  it("queries with THAT key's credential when a provider has multiple keys (04: key-level semantics)", async () => {
    const { id: providerId } = await createZhipuProvider("zhipu-multi");
    const { id: keyA } = await createZhipuKey(providerId, "sk-key-a");
    await createZhipuKey(providerId, "sk-key-b");

    const seen: string[] = [];
    const testFetcher: Fetcher = {
      async fetch(req) {
        seen.push(req.headers.get("authorization") ?? "");
        return new Response(JSON.stringify(zhipuFixture()), { status: 200 });
      },
    };
    const resp = await handleAdmin(
      adminReq("GET", `/admin/keys/${keyA}/usage`),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(resp.status).toBe(200);
    expect(seen).toEqual(["sk-key-a"]); // 用哪把 key 查，就是哪个账号的额度——不再 LIMIT 1 猜
  });

  it("serves a TTL cache hit without re-fetching upstream (~5 min) and lets refresh=1 bypass it", async () => {
    const { id: providerId } = await createZhipuProvider("zhipu-ttl");
    const { id: keyId } = await createZhipuKey(providerId, "sk-zhipu-ttl");

    let calls = 0;
    const testFetcher: Fetcher = {
      async fetch() {
        calls += 1;
        return new Response(JSON.stringify(zhipuFixture()), { status: 200 });
      },
    };
    const first = await handleAdmin(
      adminReq("GET", `/admin/keys/${keyId}/usage`),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(first.status).toBe(200);
    const second = await handleAdmin(
      adminReq("GET", `/admin/keys/${keyId}/usage`),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(second.status).toBe(200);
    expect(calls).toBe(1); // TTL 内第二次命中缓存，上游只被调一次
    const firstAt = ((await first.json()) as { fetched_at: number }).fetched_at;
    expect(((await second.json()) as { fetched_at: number }).fetched_at).toBe(firstAt);
    const refreshed = await handleAdmin(
      adminReq("GET", `/admin/keys/${keyId}/usage?refresh=1`),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(refreshed.status).toBe(200);
    expect(calls).toBe(2); // refresh=1 绕过 TTL 强制重拉（手动刷新语义）
    expect(((await refreshed.json()) as { fetched_at: number }).fetched_at)
      .toBeGreaterThanOrEqual(firstAt); // 新数据时间不早于旧值（真实时钟下应为更新）
  });

  it("keeps window identity positional when an earlier window lacks a percentage", async () => {
    // 5h 条目 percentage 非法被跳过时，周窗口仍按排序位置标「本周」，标签不前移。
    const { id: providerId } = await createZhipuProvider("zhipu-skip");
    const { id: keyId } = await createZhipuKey(providerId, "sk-zhipu-skip");
    const testFetcher: Fetcher = {
      async fetch() {
        return new Response(
          JSON.stringify({
            data: {
              limits: [
                { type: "TOKENS_LIMIT", percentage: "n/a", nextResetTime: 1_770_000_000_000 },
                { type: "TOKENS_LIMIT", percentage: 55, nextResetTime: 1_770_050_000_000 },
              ],
            },
          }),
          { status: 200 },
        );
      },
    };
    const resp = await handleAdmin(
      adminReq("GET", `/admin/keys/${keyId}/usage`),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { windows: Array<{ key: string; label: string; percentage: number; reset_at?: number }> };
    expect(body.windows).toEqual([{ key: "weekly", label: "本周", percentage: 55, reset_at: 1_770_050_000_000 }]);
  });

  it("parses defensively: old plan (single TOKENS_LIMIT), string fields, missing reset times are dropped", async () => {
    const { id: providerId } = await createZhipuProvider("zhipu-old");
    const { id: keyId } = await createZhipuKey(providerId, "sk-zhipu-old");

    const testFetcher: Fetcher = {
      async fetch() {
        return new Response(
          JSON.stringify({
            data: {
              // 老套餐：只有 1 个 TOKENS_LIMIT 且 percentage 是字符串；另一条无 nextResetTime。
              limits: [
                { type: "TOKENS_LIMIT", percentage: "88", nextResetTime: 1_770_000_000_000 },
                { type: "TOKENS_LIMIT", percentage: 5 },
                { type: "SOMETHING_NEW", percentage: 50 }, // 未知类型直接忽略
              ],
            },
          }),
          { status: 200 },
        );
      },
    };
    const resp = await handleAdmin(
      adminReq("GET", `/admin/keys/${keyId}/usage`),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { plan?: string; windows: unknown[] };
    expect(body.plan).toBeUndefined(); // level 缺省不造
    expect(body.windows).toEqual([{ key: "five_hour", label: "5 小时", percentage: 88, reset_at: 1_770_000_000_000 }]);
  });

  it("returns 502 with the upstream reason when zhipu fails, 400 for unsupported types, 404 unknown", async () => {
    const { id: failProvider } = await createZhipuProvider("zhipu-fail");
    const { id: failKey } = await createZhipuKey(failProvider, "sk-bad");
    const failing: Fetcher = { fetch: async () => new Response(JSON.stringify({ msg: "令牌错误" }), { status: 401 }) };
    const upErr = await handleAdmin(
      adminReq("GET", `/admin/keys/${failKey}/usage`),
      adminDeps(ADMIN_ENV, false, failing),
    );
    expect(upErr.status).toBe(502);
    const errBody = (await upErr.json()) as { error: { code: string; message: string } };
    expect(errBody.error.code).toBe("UPSTREAM_ERROR");
    expect(errBody.error.message).toContain("401");
    expect(errBody.error.message).toContain("令牌错误");

    const noop: Fetcher = { fetch: async () => new Response("{}") };
    // custom 类型无 adapter → 400（UI 据此不渲染用量区）。
    const { id: customProvider } = await createProvider("plain-custom");
    const { id: customKey } = await createZhipuKey(customProvider, "sk-custom");
    const unsupported = await handleAdmin(
      adminReq("GET", `/admin/keys/${customKey}/usage`),
      adminDeps(ADMIN_ENV, false, noop),
    );
    expect(unsupported.status).toBe(400);

    const unknown = await handleAdmin(
      adminReq("GET", "/admin/keys/V1StGXR8_Z5jdHi6B-myZ/usage"),
      adminDeps(ADMIN_ENV, false, noop),
    );
    expect(unknown.status).toBe(404);

    // provider 级 usage 端点已在 04 删除（无存量消费方）。
    const { id: providerId } = await createZhipuProvider("zhipu-gone");
    await createZhipuKey(providerId, "sk-gone");
    const gone = await handleAdmin(
      adminReq("GET", `/admin/providers/${providerId}/usage`),
      adminDeps(ADMIN_ENV, false, noop),
    );
    expect(gone.status).toBe(404);
  });

  it("lets a user role read usage for keys in their grants and 403s otherwise (dash-status 01)", async () => {
    const { id: providerId } = await createZhipuProvider();
    const { id: grantedKey } = await createZhipuKey(providerId);
    const { id: otherKey } = await createZhipuKey(providerId, "sk-other");

    const root = await createUser({ name: "root", role: "administrator" });
    const rootToken = root.user!.management_token!;
    const alice = await createUser({ name: "alice", role: "user" }, rootToken);
    const aliceToken = alice.user!.management_token!;

    const upstream: Fetcher = { fetch: async () => new Response(JSON.stringify(zhipuFixture()), { status: 200 }) };
    const callWithFetcher = (token: string, path: string) =>
      handleAdmin(
        new Request(`http://gw${path}`, { headers: { "x-admin-token": token } }),
        adminDeps(ADMIN_ENV, false, upstream),
      );

    // 授权后：user 角色查 grants 内上游 key 用量 → 200。
    expect((await callAs(rootToken, "PUT", `/admin/users/${alice.user!.id}/grants`, { provider_key_ids: [grantedKey] })).status).toBe(200);
    expect((await callWithFetcher(aliceToken, `/admin/keys/${grantedKey}/usage`)).status).toBe(200);

    // grants 外的上游 key → 403（范围钉定在服务端，不做响应后过滤）。
    expect((await callWithFetcher(aliceToken, `/admin/keys/${otherKey}/usage`)).status).toBe(403);
    // administrator 全量不变。
    expect((await callWithFetcher(rootToken, `/admin/keys/${otherKey}/usage`)).status).toBe(200);
  });
});

describe("key management credentials + volcengine usage (provider-usage 02/04, key-level)", () => {
  const AKSK = { type: "volcengine_ak_sk", access_key_id: "AKLT-test", secret_access_key: "sk-volc-secret" };

  function volcFixture() {
    return {
      Result: {
        PlanType: "Large",
        AFPFiveHour: { Quota: "50.0", Used: "12.5", ResetTime: 1_770_006_800_000 },
        AFPDaily: { Quota: "80.0", Used: "8.0" },
        AFPWeekly: { Quota: "350.0", Used: "70.0", ResetTime: 1_770_090_000_000 },
        AFPMonthly: { Quota: "2000.0", Used: "850.5", ResetTime: 1_770_500_000_000 },
      },
    };
  }

  async function createVolcProvider(name = "volc-a"): Promise<{ id: string }> {
    const resp = await callAdmin("POST", "/admin/providers", {
      name,
      type: "volcengine",
      endpoints: { openai: "https://ark.cn-beijing.volces.com/api/v3" },
    });
    expect(resp.status).toBe(201);
    return (await resp.json()) as { id: string };
  }

  /** createKey 可带明文管控面凭证（密文落 key 行，响应不回显）。 */
  async function createVolcKey(providerId: string, apiKey: string, credentials?: typeof AKSK): Promise<{ id: string }> {
    const resp = await callAdmin("POST", "/admin/keys", {
      provider_id: providerId,
      api_key: apiKey,
      ...(credentials ? { management_credentials: credentials } : {}),
    });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    // 明文凭证不回显（与 api_key 同口径）。
    expect(body.management_credentials).toBeUndefined();
    return body as { id: string };
  }

  it("encrypts credentials on the key row, never echoes plaintext, lists strip the blob", async () => {
    const { id: providerId } = await createVolcProvider();
    const { id: keyId } = await createVolcKey(providerId, "sk-volc-key", AKSK);
    const row = await db().prepare("SELECT management_credentials FROM provider_key WHERE id = ?").bind(keyId).first<{ management_credentials: string }>();
    expect(row!.management_credentials).toBeTruthy(); // 密文落 key 行
    expect(row!.management_credentials).not.toContain("sk-volc-secret");
    expect(row!.management_credentials).not.toContain("AKLT-test");

    const list = (await (await callAdmin("GET", "/admin/keys")).json()) as Array<Record<string, unknown>>;
    expect(list[0]!.management_credentials).toBeUndefined(); // 日常列表不外带凭证密文
    expect(keyId).toBeTruthy();
  });

  it("signs the GetAFPUsage request with THAT key's AK/SK and normalizes the four AFP windows", async () => {
    const { id: providerId } = await createVolcProvider("volc-e2e");
    const { id: keyId } = await createVolcKey(providerId, "sk-volc-e2e", AKSK);
    const seen: Array<{ url: string; method: string; body: string; auth: string | null; xDate: string | null }> = [];
    const testFetcher: Fetcher = {
      async fetch(req) {
        seen.push({
          url: req.url,
          method: req.method,
          body: await new Response(req.body).text(),
          auth: req.headers.get("authorization"),
          xDate: req.headers.get("x-date"),
        });
        return new Response(JSON.stringify(volcFixture()), { status: 200 });
      },
    };
    const resp = await handleAdmin(
      adminReq("GET", `/admin/keys/${keyId}/usage`),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      key_id: string;
      provider_type: string;
      plan?: string;
      windows: Array<{ key: string; label: string; percentage: number; absolute?: string; reset_at?: number }>;
    };
    expect(body.key_id).toBe(keyId);
    expect(body.provider_type).toBe("volcengine");
    expect(body.plan).toBe("Large");
    expect(body.windows).toEqual([
      { key: "five_hour", label: "5 小时", percentage: 25, absolute: "12.5 / 50 AFP", reset_at: 1_770_006_800_000 },
      { key: "daily", label: "近 1 天", percentage: 10, absolute: "8 / 80 AFP" },
      { key: "weekly", label: "本周", percentage: 20, absolute: "70 / 350 AFP", reset_at: 1_770_090_000_000 },
      { key: "monthly", label: "本月", percentage: 43, absolute: "850.5 / 2000 AFP", reset_at: 1_770_500_000_000 },
    ]);
    // 管控面域名 ≠ 推理数据面；AK/SK Signature V4 三头在场；body "{}"。
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://ark.cn-beijing.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toBe("{}");
    expect(seen[0]!.auth).toContain("HMAC-SHA256 Credential=AKLT-test/");
    expect(seen[0]!.auth).toContain("/cn-beijing/ark/request");
    expect(seen[0]!.xDate).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("returns 400 USAGE_NO_CREDENTIALS for a key without credentials", async () => {
    const { id: providerId } = await createVolcProvider("volc-nocred");
    const { id: keyId } = await createVolcKey(providerId, "sk-plain");
    const noop: Fetcher = { fetch: async () => new Response("{}", { status: 200 }) };
    const resp = await handleAdmin(
      adminReq("GET", `/admin/keys/${keyId}/usage`),
      adminDeps(ADMIN_ENV, false, noop),
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { code: string } };
    expect(body.error.code).toBe("USAGE_NO_CREDENTIALS");
  });

  it("merges key credentials on PUT: absent keeps, object replaces, null clears", async () => {
    const { id: providerId } = await createVolcProvider("volc-merge");
    const { id: keyId } = await createVolcKey(providerId, "sk-merge", AKSK);

    // absent → 保留原值（密文不变）。
    const before = (await db().prepare("SELECT management_credentials FROM provider_key WHERE id = ?").bind(keyId).first<{ management_credentials: string }>())!.management_credentials;
    await callAdmin("PUT", `/admin/keys/${keyId}`, { daily_token_limit: 100 });
    const afterKeep = (await db().prepare("SELECT management_credentials FROM provider_key WHERE id = ?").bind(keyId).first<{ management_credentials: string }>())!.management_credentials;
    expect(afterKeep).toBe(before);

    // 对象 → 替换（重新加密，密文变化）。
    await callAdmin("PUT", `/admin/keys/${keyId}`, {
      management_credentials: { type: "volcengine_ak_sk", access_key_id: "AKLT-2", secret_access_key: "sk-2" },
    });
    const afterReplace = (await db().prepare("SELECT management_credentials FROM provider_key WHERE id = ?").bind(keyId).first<{ management_credentials: string }>())!.management_credentials;
    expect(afterReplace).not.toBe(before);
    expect(afterReplace).not.toContain("sk-2"); // 仍是密文

    // null → 清除。
    await callAdmin("PUT", `/admin/keys/${keyId}`, { management_credentials: null });
    const afterClear = (await db().prepare("SELECT management_credentials FROM provider_key WHERE id = ?").bind(keyId).first<{ management_credentials: string | null }>())!.management_credentials;
    expect(afterClear).toBeNull();
  });

  it("exports key credentials as ciphertext (restore replays them as plaintext objects)", async () => {
    const { id: providerId } = await createVolcProvider("volc-export");
    const { id: keyId } = await createVolcKey(providerId, "sk-export", AKSK);
    const resp = await callAdmin("GET", "/admin/export");
    const body = await resp.text();
    expect(body).not.toContain("sk-volc-secret"); // 明文永不出现
    const exported = JSON.parse(body) as { keys: Array<{ management_credentials?: string }> };
    expect(exported.keys[0]!.management_credentials).toBeTruthy(); // 密文随行
    expect(keyId).toBeTruthy();
  });

  it("maps a control-plane 401 to a readable 502", async () => {
    const { id: providerId } = await createVolcProvider("volc-401");
    const { id: keyId } = await createVolcKey(providerId, "sk-401", AKSK);
    const failing: Fetcher = {
      async fetch() {
        return new Response(
          JSON.stringify({ ResponseMetadata: { Error: { Message: "not authorized" } } }),
          { status: 401 },
        );
      },
    };
    const resp = await handleAdmin(
      adminReq("GET", `/admin/keys/${keyId}/usage`),
      adminDeps(ADMIN_ENV, false, failing),
    );
    expect(resp.status).toBe(502);
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UPSTREAM_ERROR");
    expect(body.error.message).toContain("not authorized");
  });
});

describe("provider connectivity test relay (provider-usage 03)", () => {
  it("relays the hand-entered key to the chosen endpoint, defaulting the model from mappings", async () => {
    const { id: providerId } = await createProvider();
    await callAdmin("POST", "/admin/mappings", { client_model: "m1", provider_id: providerId, upstream_model: "a-up" });

    const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const testFetcher: Fetcher = {
      async fetch(req) {
        seen.push({ url: req.url, auth: req.headers.get("authorization"), body: await new Response(req.body).json() });
        return new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 });
      },
    };
    const resp = await handleAdmin(
      adminReq("POST", `/admin/providers/${providerId}/test`, { api_key: "sk-hand-entered", protocol: "openai" }),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { provider_id: string; protocol: string; model: string; ok: boolean; error?: string };
    expect(body.provider_id).toBe(providerId);
    expect(body.protocol).toBe("openai");
    expect(body.model).toBe("a-up"); // model 缺省取该供应商启用映射的 upstream_model
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Incorrect API key");
    expect(seen[0]!.url).toBe("https://p-a.test/v1/chat/completions");
    expect(seen[0]!.auth).toBe("Bearer sk-hand-entered"); // 手输 Key 直通上游，不落库
    // 明文 Key 不出现在响应里。
    expect(JSON.stringify(body)).not.toContain("sk-hand-entered");
  });

  it("falls back to preset suggested model and passes anthropic protocol through", async () => {
    const resp = await callAdmin("POST", "/admin/providers", {
      name: "volc-relay", type: "volcengine", endpoints: { anthropic: "https://ark.cn-beijing.volces.com/api/plan" },
    });
    const { id: providerId } = (await resp.json()) as { id: string };

    const seen: Array<{ url: string; headers: Headers }> = [];
    const testFetcher: Fetcher = {
      async fetch(req) {
        seen.push({ url: req.url, headers: req.headers });
        return new Response("{}", { status: 200 });
      },
    };
    const out = await handleAdmin(
      adminReq("POST", `/admin/providers/${providerId}/test`, { api_key: "sk-xyz", protocol: "anthropic" }),
      adminDeps(ADMIN_ENV, false, testFetcher),
    );
    expect(out.status).toBe(200);
    const body = (await out.json()) as { model: string; ok: boolean };
    expect(body.model).toBe("doubao-pro-32k"); // preset suggested_models[0]
    expect(seen[0]!.url).toBe("https://ark.cn-beijing.volces.com/api/plan/v1/messages");
    expect(seen[0]!.headers.get("x-api-key")).toBe("sk-xyz"); // anthropic 形鉴权
  });

  it("rejects missing key/protocol, unknown providers and unconfigured endpoints", async () => {
    const noop: Fetcher = { fetch: async () => new Response("{}") };
    const { id: providerId } = await createProvider("relay-bad");

    const noKey = await handleAdmin(
      adminReq("POST", `/admin/providers/${providerId}/test`, { protocol: "openai" }),
      adminDeps(ADMIN_ENV, false, noop),
    );
    expect(noKey.status).toBe(400);

    const noProtocol = await handleAdmin(
      adminReq("POST", `/admin/providers/${providerId}/test`, { api_key: "sk-1234" }),
      adminDeps(ADMIN_ENV, false, noop),
    );
    expect(noProtocol.status).toBe(400);

    const badProtocol = await handleAdmin(
      adminReq("POST", `/admin/providers/${providerId}/test`, { api_key: "sk-1234", protocol: "gemini" }),
      adminDeps(ADMIN_ENV, false, noop),
    );
    expect(badProtocol.status).toBe(400); // 只放行 openai/anthropic（UI 的端点档）

    const missingEndpoint = await handleAdmin(
      adminReq("POST", `/admin/providers/${providerId}/test`, { api_key: "sk-1234", protocol: "anthropic" }),
      adminDeps(ADMIN_ENV, false, noop),
    );
    expect(missingEndpoint.status).toBe(400); // 只配了 openai 端点

    const unknown = await handleAdmin(
      adminReq("POST", "/admin/providers/V1StGXR8_Z5jdHi6B-myZ/test", { api_key: "sk-1234", protocol: "openai" }),
      adminDeps(ADMIN_ENV, false, noop),
    );
    expect(unknown.status).toBe(404);
  });
});

describe("audit and export", () => {
  it("records every write in admin_audit", async () => {
    const { id } = await createProvider();
    await callAdmin("PUT", `/admin/providers/${id}`, { enabled: false });
    await callAdmin("DELETE", `/admin/providers/${id}`);

    const resp = await callAdmin("GET", "/admin/audit");
    const audit = (await resp.json()) as Array<{ action: string; target: string; ts: number }>;
    expect(audit.map((a) => a.action)).toEqual(["provider.delete", "provider.update", "provider.create"]);
    expect(audit.every((a) => a.ts === T0)).toBe(true);
  });

  it("exports the versioned backup envelope: ciphertext in, plaintext out (desktop 06)", async () => {
    const { id: providerId } = await createProvider();
    await callAdmin("POST", "/admin/keys", { provider_id: providerId, api_key: "sk-hush-secret" });
    await callAdmin("POST", "/admin/mappings", { client_model: "m1", provider_id: providerId, upstream_model: "a-up" });

    const resp = await callAdmin("GET", "/admin/export");
    const body = await resp.text();
    // 明文永不出现；密文（encrypted_key）原样随行（灾备快照口径）。
    expect(body).not.toContain("sk-hush-secret");
    expect(body).not.toContain("key_hash");
    const exported = JSON.parse(body) as {
      version: number; exported_at: number;
      providers: unknown[]; keys: Array<{ encrypted_key?: string }>; mappings: unknown[];
      users: unknown[]; grants: unknown[]; access_keys: unknown[]; audit: unknown[];
    };
    expect(exported.version).toBe(1);
    expect(exported.exported_at).toBe(T0);
    expect(exported.providers).toHaveLength(1);
    expect(exported.keys).toHaveLength(1);
    expect(exported.keys[0]!.encrypted_key).toBeTruthy();
    expect(exported.mappings).toHaveLength(1);
    // 其余四段（desktop 06 扩容）空集合也在信封里。
    expect(Array.isArray(exported.users)).toBe(true);
    expect(Array.isArray(exported.grants)).toBe(true);
    expect(Array.isArray(exported.access_keys)).toBe(true);
    expect(Array.isArray(exported.audit)).toBe(true);
  });
});

describe("config cache invalidation on the proxy path (PRD F2.5)", () => {
  it("gateway config, access key and grants created via /admin are usable on /v1 immediately", async () => {
    const handler = createHandler({ rng: () => 0 });
    const workerEnv = {
      DB: env.DB,
      ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      ADMIN_TOKEN: "admin-secret",
    };
    const admin = (path: string, method: string, token: string, body?: unknown) =>
      handler(
        new Request(`http://gw${path}`, {
          method,
          headers: { "x-admin-token": token, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        workerEnv,
      );

    // Prime the config cache (401：尚无访问 key，但快照已加载)。
    const before = await handler(new Request("http://gw/v1/models", { headers: { authorization: "Bearer lgk_none" } }), workerEnv);
    expect(before.status).toBe(401);

    // Write through the full worker handler so both planes share the cache.
    const providerResp = await admin("/admin/providers", "POST", "admin-secret", { name: "p-x", endpoints: { openai: "https://x.test" } });
    expect(providerResp.status).toBe(201);
    const { id: providerId } = (await providerResp.json()) as { id: string };
    const keyResp = await admin("/admin/keys", "POST", "admin-secret", { provider_id: providerId, api_key: "sk-upstream-xxxx" });
    expect(keyResp.status).toBe(201);
    const providerKeyId = ((await keyResp.json()) as { id: string }).id;
    expect((await admin("/admin/mappings", "POST", "admin-secret", { client_model: "mx", provider_id: providerId, upstream_model: "x-up" })).status).toBe(201);

    // 引导建 root（此后 ADMIN_TOKEN 失效）→ root 建 alice → alice 自建 lgk_。
    const rootResp = await admin("/admin/users", "POST", "admin-secret", { name: "root", role: "administrator" });
    expect(rootResp.status).toBe(201);
    const root = (await rootResp.json()) as { management_token: string };
    const aliceResp = await admin("/admin/users", "POST", root.management_token, { name: "alice", role: "user" });
    expect(aliceResp.status).toBe(201);
    const alice = (await aliceResp.json()) as { id: string; management_token: string };
    const accessKeyResp = await admin("/admin/access-keys", "POST", alice.management_token, { name: "scene-1" });
    expect(accessKeyResp.status).toBe(201);
    const lgk = ((await accessKeyResp.json()) as { access_key: string }).access_key;

    // 未授权：key 有效但无 grant → /v1/models 收敛为空。
    const ungranted = await handler(new Request("http://gw/v1/models", { headers: { authorization: `Bearer ${lgk}` } }), workerEnv);
    expect(((await ungranted.json()) as { data: unknown[] }).data).toHaveLength(0);

    // 授权后（同 isolate，缓存已失效）立即可见。
    expect((await admin(`/admin/users/${alice.id}/grants`, "PUT", root.management_token, { provider_key_ids: [providerKeyId] })).status).toBe(200);

    const after = await handler(new Request("http://gw/v1/models", { headers: { authorization: `Bearer ${lgk}` } }), workerEnv);
    const models = (await after.json()) as { data: Array<{ id: string }> };
    expect(models.data.map((m) => m.id)).toEqual(["mx"]);
  });
});

// ---- users & management tokens (multi-user ticket 01) -------------------------

interface CreatedUser {
  id: string;
  name: string;
  role: string;
  enabled: boolean;
  management_token?: string;
  token_hint?: string;
}

async function createUser(body: { name: string; role?: string }, asToken?: string): Promise<{ resp: Response; user?: CreatedUser }> {
  const payload = body.role ? { name: body.name, role: body.role } : { name: body.name };
  // 存在启用 administrator 后 ADMIN_TOKEN 失效，须以 lgm_ 继续操作（ticket 02）。
  const resp = asToken ? await callAs(asToken, "POST", "/admin/users", payload) : await callAdmin("POST", "/admin/users", payload);
  const user = resp.status === 201 ? ((await resp.json()) as CreatedUser) : undefined;
  return { resp, user };
}

describe("users & management tokens (multi-user 01)", () => {
  it("creates a user and returns the lgm_ token exactly once", async () => {
    const { resp, user } = await createUser({ name: "alice", role: "user" });
    expect(resp.status).toBe(201);
    expect(user).toMatchObject({ name: "alice", role: "user", enabled: true });
    expect(user!.management_token).toMatch(/^lgm_[A-Za-z0-9_-]+$/);
    expect(user!.token_hint).toBe(user!.management_token!.slice(-4));

    // DB holds only the hash — never the plaintext.
    const rows = await db().prepare("SELECT token_hash FROM management_token WHERE user_id = ?").bind(user!.id).all<{ token_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.token_hash).not.toContain(user!.management_token);
    expect(rows.results[0]!.token_hash).toHaveLength(64);

    // List view carries no token material at all.
    const listResp = await callAdmin("GET", "/admin/users");
    const list = (await listResp.json()) as CreatedUser[];
    const entry = list.find((u) => u.id === user!.id);
    expect(entry).toMatchObject({ name: "alice", role: "user" });
    expect(JSON.stringify(list)).not.toContain("lgm_");
    expect(JSON.stringify(list)).not.toContain("token_hash");
  });

  it("rejects an invalid role with 400", async () => {
    const { resp } = await createUser({ name: "bad", role: "superadmin" });
    expect(resp.status).toBe(400);
  });

  it("resets the management token: old hash gone, new plaintext returned once", async () => {
    const { user } = await createUser({ name: "bob", role: "user" });
    const before = await db().prepare("SELECT token_hash FROM management_token WHERE user_id = ?").bind(user!.id).all<{ token_hash: string }>();
    const oldHash = before.results[0]!.token_hash;

    const resp = await callAdmin("POST", `/admin/users/${user!.id}/token`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { management_token: string; token_hint: string };
    expect(body.management_token).toMatch(/^lgm_/);

    const rows = (await db().prepare("SELECT token_hash FROM management_token WHERE user_id = ?").bind(user!.id).all<{ token_hash: string }>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(oldHash);
  });

  it("updates (rename/role) and toggles enabled", async () => {
    const { user: root } = await createUser({ name: "root", role: "administrator" });
    const rootToken = root!.management_token!;
    const { user } = await createUser({ name: "carol", role: "user" }, rootToken);
    const rename = await callAs(rootToken, "PUT", `/admin/users/${user!.id}`, { name: "carol2", role: "administrator" });
    expect(rename.status).toBe(200);
    expect(await rename.json()).toMatchObject({ name: "carol2", role: "administrator" });

    // root 仍是启用管理员，禁用 carol2 不触发最后管理员守卫。
    const disable = await callAs(rootToken, "PUT", `/admin/users/${user!.id}`, { enabled: false });
    expect(disable.status).toBe(200);
    expect(await disable.json()).toMatchObject({ enabled: false });
  });

  it("deletes a user and cascades the management token", async () => {
    const { user } = await createUser({ name: "dave", role: "user" });
    const del = await callAdmin("DELETE", `/admin/users/${user!.id}`);
    expect(del.status).toBe(200);
    const tokens = await db().prepare("SELECT id FROM management_token WHERE user_id = ?").bind(user!.id).all();
    expect(tokens.results).toHaveLength(0);
    expect((await callAdmin("GET", "/admin/users")).status).toBe(200);
  });

  it("returns 404 for unknown user ids", async () => {
    expect((await callAdmin("PUT", "/admin/users/does-not-exist", { enabled: false })).status).toBe(404);
    expect((await callAdmin("DELETE", "/admin/users/does-not-exist")).status).toBe(404);
    expect((await callAdmin("POST", "/admin/users/does-not-exist/token")).status).toBe(404);
  });

  it("refuses disabling, demoting or deleting the last enabled administrator (409)", async () => {
    const { user } = await createUser({ name: "root", role: "administrator" });
    const token = user!.management_token!;
    expect((await callAs(token, "PUT", `/admin/users/${user!.id}`, { enabled: false })).status).toBe(409);
    expect((await callAs(token, "PUT", `/admin/users/${user!.id}`, { role: "user" })).status).toBe(409);
    expect((await callAs(token, "DELETE", `/admin/users/${user!.id}`)).status).toBe(409);

    // Two admins: the non-last one may step down.
    const { user: second } = await createUser({ name: "root2", role: "administrator" }, token);
    expect((await callAs(token, "PUT", `/admin/users/${second!.id}`, { enabled: false })).status).toBe(200);
  });

  it("audits every lifecycle action", async () => {
    const { user } = await createUser({ name: "erin", role: "user" });
    await callAdmin("POST", `/admin/users/${user!.id}/token`);
    await callAdmin("PUT", `/admin/users/${user!.id}`, { enabled: false });
    await callAdmin("DELETE", `/admin/users/${user!.id}`);
    const audit = (await (await callAdmin("GET", "/admin/audit")).json()) as Array<{ action: string; target: string }>;
    const actions = audit.filter((a) => a.target === user!.id).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["user.create", "user.token.reset", "user.update", "user.delete"]));
    // 引导阶段（虚拟管理员）actor 为空。
    const actorRows = (await db().prepare("SELECT DISTINCT actor_user_id FROM admin_audit WHERE target = ?").bind(user!.id).all<{ actor_user_id: string | null }>()).results;
    expect(actorRows).toHaveLength(1);
    expect(actorRows[0]!.actor_user_id).toBeNull();
  });

  it("returns a user-specific 409 when renaming onto an existing name", async () => {
    await createUser({ name: "taken", role: "user" });
    const { user } = await createUser({ name: "frank", role: "user" });
    const resp = await callAdmin("PUT", `/admin/users/${user!.id}`, { name: "taken" });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { error: { message: string } };
    expect(body.error.message).toContain("user name");
  });
});

// ---- 管理面身份鉴权（multi-user 02）--------------------------------------------

describe("management-plane identity auth (multi-user 02)", () => {
  it("resolves a valid lgm_ token to an identity on /admin/me", async () => {
    const { user } = await createUser({ name: "alice", role: "user" });
    const resp = await callAs(user!.management_token!, "GET", "/admin/me");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ id: user!.id, name: "alice", role: "user" });
  });

  it("rejects invalid, disabled-token and disabled-user credentials with 401", async () => {
    expect((await callAs("lgm_does-not-exist", "GET", "/admin/me")).status).toBe(401);

    const { user } = await createUser({ name: "bob", role: "user" });
    // token 被禁（management_token.enabled = 0，库层直改）
    await db().prepare("UPDATE management_token SET enabled = 0 WHERE user_id = ?").bind(user!.id).run();
    expect((await callAs(user!.management_token!, "GET", "/admin/me")).status).toBe(401);

    // 所属用户被禁用
    const { user: carol } = await createUser({ name: "carol", role: "user" });
    await callAdmin("PUT", `/admin/users/${carol!.id}`, { enabled: false });
    expect((await callAs(carol!.management_token!, "GET", "/admin/me")).status).toBe(401);
  });

  it("gates global resources: user role gets 403, administrator full access", async () => {
    const { user: root } = await createUser({ name: "root", role: "administrator" });
    const { user: alice } = await createUser({ name: "alice", role: "user" }, root!.management_token);

    for (const path of ["/admin/providers", "/admin/keys", "/admin/mappings", "/admin/users", "/admin/audit", "/admin/export"]) {
      const resp = await callAs(alice!.management_token!, "GET", path);
      expect(resp.status, `${path} should be 403 for user role`).toBe(403);
      await expect(resp.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
    }
    // /admin/logs 自 desktop 04 起对 user 角色放行（SQL 钉定只回自己的行，
    // 供本地镜像同步；详细自范围断言见 server.test.ts 镜像用例）。
    expect((await callAs(alice!.management_token!, "GET", "/admin/logs")).status).toBe(200);
    // user 对全局资源的写操作同样 403。
    expect((await callAs(alice!.management_token!, "POST", "/admin/providers", { name: "nope", endpoints: {} })).status).toBe(403);

    expect((await callAs(root!.management_token!, "GET", "/admin/providers")).status).toBe(200);
    expect((await callAs(root!.management_token!, "GET", "/admin/me")).status).toBe(200);
  });

  it("ADMIN_TOKEN works only until an enabled administrator exists", async () => {
    // 无启用管理员：ADMIN_TOKEN 引导放行（/admin/me 为虚拟 administrator）。
    const boot = await callAdmin("GET", "/admin/me");
    expect(boot.status).toBe(200);
    expect(await boot.json()).toMatchObject({ id: null, name: null, role: "administrator" });

    // 创建 administrator 后 ADMIN_TOKEN 一律 401，但管理员 lgm_ 正常。
    const { user: root } = await createUser({ name: "root", role: "administrator" });
    const dead = await callAdmin("GET", "/admin/providers");
    expect(dead.status).toBe(401);
    await expect(dead.json()).resolves.toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect((await callAs(root!.management_token!, "GET", "/admin/users")).status).toBe(200);

    // 写操作同样被拒——引导凭证不构成后门。
    expect((await callAdmin("POST", "/admin/users", { name: "eve", role: "user" })).status).toBe(401);
  });

  it("maps Cloudflare Access credentials to a virtual administrator", async () => {
    // 存在启用管理员时 CF Access 依然可用（不受引导规则影响）。
    await createUser({ name: "root", role: "administrator" });
    const cfDeps = {
      db: new D1AdminDb(env.DB as D1Database),
      credentials: {
        cfAccessClientId: "cid",
        cfAccessClientSecret: "csecret",
      },
      now: () => T0,
    };
    const cfHeaders = { "cf-access-client-id": "cid", "cf-access-client-secret": "csecret" };

    const resp = await handleAdmin(new Request("http://gw/admin/me", { headers: cfHeaders }), cfDeps);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ id: null, name: null, role: "administrator" });

    // 写操作可用且审计 actor 为空（虚拟管理员）。
    const write = await handleAdmin(
      new Request("http://gw/admin/providers", {
        method: "POST",
        headers: { ...cfHeaders, "content-type": "application/json" },
        body: JSON.stringify({ name: "cf-p", endpoints: { openai: "https://cf.test" } }),
      }),
      cfDeps,
    );
    expect(write.status).toBe(201);
    const audit = (await db()
      .prepare("SELECT actor_user_id FROM admin_audit WHERE action = 'provider.create'")
      .all<{ actor_user_id: string | null }>()).results;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_user_id).toBeNull();
  });

  it("keeps the planes mutually exclusive: lgk_ never authenticates /admin", async () => {
    await createUser({ name: "root", role: "administrator" });
    expect((await callAs("lgk_whatever-access-key", "GET", "/admin/me")).status).toBe(401);
    expect((await callAs("lgk_whatever-access-key", "GET", "/admin/providers")).status).toBe(401);
  });

  it("records the acting user id in audit rows (actor_user_id)", async () => {
    // 引导虚拟管理员建 root：actor 为空。
    const { user: root } = await createUser({ name: "root", role: "administrator" });
    // root 用自己的 lgm_ 操作：审计带真实 actor_user_id。
    const created = await callAs(root!.management_token!, "POST", "/admin/users", { name: "bob", role: "user" });
    expect(created.status).toBe(201);
    const bob = (await created.json()) as { id: string };
    await callAs(root!.management_token!, "PUT", `/admin/users/${bob.id}`, { enabled: false });

    const audit = (await (await callAs(root!.management_token!, "GET", "/admin/audit")).json()) as Array<{
      action: string;
      target: string;
      actor_user_id: string | null;
    }>;
    const bobCreate = audit.find((a) => a.action === "user.create" && a.target === bob.id);
    const bobUpdate = audit.find((a) => a.action === "user.update" && a.target === bob.id);
    const rootCreate = audit.find((a) => a.action === "user.create" && a.target === root!.id);
    expect(bobCreate?.actor_user_id).toBe(root!.id);
    expect(bobUpdate?.actor_user_id).toBe(root!.id);
    expect(rootCreate?.actor_user_id).toBeNull(); // 引导阶段虚拟管理员
  });
});

// ---- 访问 key 与授权管理（multi-user 03）----------------------------------------

async function createProviderKey(providerId: string, apiKey: string, asToken?: string): Promise<string> {
  const resp = asToken
    ? await callAs(asToken, "POST", "/admin/keys", { provider_id: providerId, api_key: apiKey })
    : await callAdmin("POST", "/admin/keys", { provider_id: providerId, api_key: apiKey });
  expect(resp.status).toBe(201);
  return ((await resp.json()) as { id: string }).id;
}

/** 通用 fixture：provider + 两把上游 key + root 管理员 + alice/bob 两个 user。 */
async function grantFixture() {
  const { id: providerId } = await createProvider("p-g"); // 尚无用户，ADMIN_TOKEN 引导可用
  const keyA = await createProviderKey(providerId, "sk-upstream-aaaa");
  const keyB = await createProviderKey(providerId, "sk-upstream-bbbb");
  const { user: root } = await createUser({ name: "root", role: "administrator" });
  const rootToken = root!.management_token!;
  const { user: alice } = await createUser({ name: "alice", role: "user" }, rootToken);
  const { user: bob } = await createUser({ name: "bob", role: "user" }, rootToken);
  return { providerId, keyA, keyB, root, rootToken, alice, bob };
}

describe("grants management (multi-user 03)", () => {
  it("replaces the whole grant set, dedupes and validates provider keys", async () => {
    const { keyA, keyB, rootToken, alice } = await grantFixture();

    // 重复提交去重；整组替换。
    const put = await callAs(rootToken, "PUT", `/admin/users/${alice!.id}/grants`, {
      provider_key_ids: [keyA, keyA, keyB],
    });
    expect(put.status).toBe(200);
    const grants = (await put.json()) as { grants: Array<{ provider_key_id: string; provider_name: string; key_hint: string }> };
    expect(grants.grants.map((g) => g.provider_key_id).sort()).toEqual([keyA, keyB].sort());
    expect(grants.grants[0]).toMatchObject({ provider_name: "p-g" });
    // dash-status 02：授权视图带 provider_type（个人盘套餐用量卡判渲染用）。
    expect(grants.grants[0]).toHaveProperty("provider_type");
    expect(new Set(grants.grants.map((g) => g.key_hint))).toEqual(new Set(["aaaa", "bbbb"]));

    // GET 返回同一集合。
    const get = await callAs(rootToken, "GET", `/admin/users/${alice!.id}/grants`);
    expect(await get.json()).toMatchObject({ grants: grants.grants });

    // 不存在的 provider_key → 404，且原集合不被破坏。
    const bad = await callAs(rootToken, "PUT", `/admin/users/${alice!.id}/grants`, {
      provider_key_ids: [keyB, "V1StGXR8_Z5jdHi6B-nope"],
    });
    expect(bad.status).toBe(404);
    const after = (await (await callAs(rootToken, "GET", `/admin/users/${alice!.id}/grants`)).json()) as { grants: unknown[] };
    expect(after.grants).toHaveLength(2);

    // 空数组 → 清空。
    const empty = await callAs(rootToken, "PUT", `/admin/users/${alice!.id}/grants`, { provider_key_ids: [] });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { grants: unknown[] }).grants).toHaveLength(0);

    // 未知用户 → 404；user 角色 → 403。
    expect((await callAs(rootToken, "GET", "/admin/users/does-not-exist/grants")).status).toBe(404);
    expect((await callAs(alice!.management_token!, "PUT", `/admin/users/${alice!.id}/grants`, { provider_key_ids: [keyA] })).status).toBe(403);
  });

  it("cascades grant cleanup when the user or the provider key is deleted", async () => {
    const { providerId, keyA, keyB, rootToken, alice, bob } = await grantFixture();
    await callAs(rootToken, "PUT", `/admin/users/${alice!.id}/grants`, { provider_key_ids: [keyA, keyB] });
    await callAs(rootToken, "PUT", `/admin/users/${bob!.id}/grants`, { provider_key_ids: [keyB] });

    // 删除上游 key：引用它的授权级联消失，其余保留。
    await callAs(rootToken, "DELETE", `/admin/keys/${keyA}`);
    let grants = await db().prepare("SELECT provider_key_id FROM user_key_grant").all<{ provider_key_id: string }>();
    expect(grants.results.map((g) => g.provider_key_id)).toEqual([keyB, keyB]);

    // 删除用户：其授权与访问 key 一并级联清理。
    const ak = await (await callAs(alice!.management_token!, "POST", "/admin/access-keys", { name: "alice-key" })).json() as { id: string };
    await callAs(rootToken, "DELETE", `/admin/users/${alice!.id}`);
    grants = await db().prepare("SELECT provider_key_id FROM user_key_grant").all<{ provider_key_id: string }>();
    expect(grants.results.map((g) => g.provider_key_id)).toEqual([keyB]); // 只剩 bob 的
    const keys = await db().prepare("SELECT id FROM access_key").all<{ id: string }>();
    expect(keys.results.map((k) => k.id)).toEqual([]);
    expect(ak.id).toBeTruthy();
    expect(providerId).toBeTruthy();
  });
});

describe("access keys (multi-user 03)", () => {
  it("creates a named lgk_ key with one-time plaintext and metadata-only listing", async () => {
    const { rootToken, alice } = await grantFixture();
    const created = await callAs(alice!.management_token!, "POST", "/admin/access-keys", { name: "scene-1" });
    expect(created.status).toBe(201);
    const key = (await created.json()) as { id: string; user_id: string; name: string; key_hint: string; access_key: string };
    expect(key.access_key).toMatch(/^lgk_[A-Za-z0-9_-]+$/);
    expect(key.key_hint).toBe(key.access_key.slice(-4));
    expect(key.user_id).toBe(alice!.id);

    // 库里只有哈希，绝无明文。
    const row = await db().prepare("SELECT key_hash FROM access_key WHERE id = ?").bind(key.id).first<{ key_hash: string }>();
    expect(row!.key_hash).not.toContain(key.access_key);
    expect(row!.key_hash).toHaveLength(64);

    // 列表只见元数据。
    const list = await callAs(alice!.management_token!, "GET", "/admin/access-keys");
    const body = await list.text();
    expect(body).not.toContain("lgk_");
    expect(body).not.toContain("key_hash");
    const listJson = JSON.parse(body) as Array<{ name: string; key_hint: string; enabled: boolean }>;
    expect(listJson).toHaveLength(1);
    expect(listJson[0]).toMatchObject({ name: "scene-1", key_hint: key.access_key.slice(-4), enabled: true });
  });

  it("scopes user operations to their own keys (user_id never from the body)", async () => {
    const { rootToken, alice, bob } = await grantFixture();
    const aliceToken = alice!.management_token!;
    const bobToken = bob!.management_token!;

    // alice 建两把（body 里塞 user_id 也无效，归属取自身份）。
    const a1 = await (await callAs(aliceToken, "POST", "/admin/access-keys", { name: "a1", user_id: bob!.id })).json() as { id: string; user_id: string };
    expect(a1.user_id).toBe(alice!.id);
    const b1 = await (await callAs(bobToken, "POST", "/admin/access-keys", { name: "b1" })).json() as { id: string };

    // 各自列表只见自己的。
    const aliceList = (await (await callAs(aliceToken, "GET", "/admin/access-keys")).json()) as Array<{ id: string }>;
    expect(aliceList.map((k) => k.id)).toEqual([a1.id]);

    // 操作他人的 key → 404。
    expect((await callAs(aliceToken, "PUT", `/admin/access-keys/${b1.id}`, { name: "hijack" })).status).toBe(404);
    expect((await callAs(aliceToken, "DELETE", `/admin/access-keys/${b1.id}`)).status).toBe(404);

    // 自己的可重命名/启停/删除。
    expect((await callAs(aliceToken, "PUT", `/admin/access-keys/${a1.id}`, { name: "a1-renamed", enabled: false })).status).toBe(200);
    expect((await callAs(aliceToken, "DELETE", `/admin/access-keys/${a1.id}`)).status).toBe(200);
    expect((await callAs(aliceToken, "GET", "/admin/access-keys")).status).toBe(200);

    // administrator 看得到全部。
    const all = (await (await callAs(rootToken, "GET", "/admin/access-keys")).json()) as Array<{ id: string }>;
    expect(all.map((k) => k.id)).toEqual([b1.id]);
  });

  it("lets an administrator create a key on behalf of any user", async () => {
    const { rootToken, alice } = await grantFixture();
    const resp = await callAs(rootToken, "POST", `/admin/users/${alice!.id}/access-keys`, { name: "ops-issued" });
    expect(resp.status).toBe(201);
    const key = (await resp.json()) as { user_id: string; name: string; access_key: string };
    expect(key.user_id).toBe(alice!.id);
    expect(key.access_key).toMatch(/^lgk_/);
    expect((await callAs(rootToken, "POST", "/admin/users/does-not-exist/access-keys", { name: "x" })).status).toBe(404);
  });

  it("keeps the planes mutually exclusive: lgm_ never authenticates /v1", async () => {
    const { alice } = await grantFixture();
    const handler = createHandler({ rng: () => 0 });
    const workerEnv = { DB: env.DB, ENCRYPTION_KEY: TEST_ENCRYPTION_KEY };
    const resp = await handler(
      new Request("http://gw/v1/models", { headers: { authorization: `Bearer ${alice!.management_token}` } }),
      workerEnv,
    );
    expect(resp.status).toBe(401);
  });

  it("audits every access-key and grant lifecycle action with the actor", async () => {
    const { keyA, root, rootToken, alice } = await grantFixture();
    const aliceToken = alice!.management_token!;
    const key = await (await callAs(aliceToken, "POST", "/admin/access-keys", { name: "audited" })).json() as { id: string };
    await callAs(aliceToken, "PUT", `/admin/access-keys/${key.id}`, { enabled: false });
    await callAs(aliceToken, "DELETE", `/admin/access-keys/${key.id}`);
    await callAs(rootToken, "PUT", `/admin/users/${alice!.id}/grants`, { provider_key_ids: [keyA] });

    const audit = (await (await callAs(rootToken, "GET", "/admin/audit")).json()) as Array<{
      action: string; target: string; actor_user_id: string | null;
    }>;
    const actions = audit.filter((a) => a.target === key.id || (a.action === "grants.replace" && a.target === alice!.id));
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(["access_key.create", "access_key.update", "access_key.delete", "grants.replace"]),
    );
    for (const a of actions.filter((a) => a.action.startsWith("access_key"))) {
      expect(a.actor_user_id).toBe(alice!.id);
    }
    expect(audit.find((a) => a.action === "grants.replace")!.actor_user_id).toBe(root!.id);
  });
});

// ---- 限额（quota 01：数据模型与管理面 API）----------------------------------------

describe("quota limits on admin API (quota 01)", () => {
  it("provider keys carry asset-level limits through create/update/list/export", async () => {
    const { id: providerId } = await createProvider("p-q");
    const created = await callAdmin("POST", "/admin/keys", {
      provider_id: providerId,
      api_key: "sk-upstream-qqqq",
      daily_token_limit: 1_000_000,
      daily_request_limit: 500,
    });
    expect(created.status).toBe(201);
    const key = (await created.json()) as { id: string; daily_token_limit: number; daily_request_limit: number };
    expect(key).toMatchObject({ daily_token_limit: 1_000_000, daily_request_limit: 500 });

    // PUT 可改限额；未传字段保持原值（enabled 语义不变）。
    const put = await callAdmin("PUT", `/admin/keys/${key.id}`, { daily_token_limit: 2_000_000 });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ id: key.id, daily_token_limit: 2_000_000, daily_request_limit: 500 });

    const list = (await (await callAdmin("GET", "/admin/keys")).json()) as Array<{ id: string; daily_token_limit: number; daily_request_limit: number }>;
    expect(list.find((k) => k.id === key.id)).toMatchObject({ daily_token_limit: 2_000_000, daily_request_limit: 500 });
    const exported = (await (await callAdmin("GET", "/admin/export")).json()) as { keys: Array<{ id: string; daily_token_limit: number }> };
    expect(exported.keys.find((k) => k.id === key.id)!.daily_token_limit).toBe(2_000_000);

    // 非法输入：负数 / 非整数 → 400。
    expect((await callAdmin("POST", "/admin/keys", { provider_id: providerId, api_key: "sk-upstream-rrrr", daily_token_limit: -1 })).status).toBe(400);
    expect((await callAdmin("PUT", `/admin/keys/${key.id}`, { daily_request_limit: 1.5 })).status).toBe(400);
  });

  it("access keys: user sets own limits; foreign keys stay 404; admin edits any key", async () => {
    const { rootToken, alice, bob } = await grantFixture();
    const aliceToken = alice!.management_token!;
    const bobToken = bob!.management_token!;

    const created = await callAs(aliceToken, "POST", "/admin/access-keys", {
      name: "scene-limited", daily_token_limit: 50_000, daily_request_limit: 100, max_concurrency: 4,
    });
    expect(created.status).toBe(201);
    const key = (await created.json()) as { id: string; daily_token_limit: number; daily_request_limit: number; max_concurrency: number };
    expect(key).toMatchObject({ daily_token_limit: 50_000, daily_request_limit: 100, max_concurrency: 4 });

    // 未传限额 = 0（不限）。
    const plain = (await (await callAs(bobToken, "POST", "/admin/access-keys", { name: "b-plain" })).json()) as { id: string; daily_token_limit: number };
    expect(plain.daily_token_limit).toBe(0);

    // 改自己的限额；未传字段保持原值。
    const put = await callAs(aliceToken, "PUT", `/admin/access-keys/${key.id}`, { daily_request_limit: 200 });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ id: key.id, daily_token_limit: 50_000, daily_request_limit: 200, max_concurrency: 4 });

    // 改他人的 key 仍 404（归属谓词语义保留）。
    expect((await callAs(aliceToken, "PUT", `/admin/access-keys/${plain.id}`, { daily_token_limit: 1 })).status).toBe(404);

    // administrator 可改任意 key。
    expect((await callAs(rootToken, "PUT", `/admin/access-keys/${plain.id}`, { max_concurrency: 2 })).status).toBe(200);
    const list = (await (await callAs(rootToken, "GET", "/admin/access-keys")).json()) as Array<{ id: string; max_concurrency: number }>;
    expect(list.find((k) => k.id === plain.id)!.max_concurrency).toBe(2);

    // 非法输入：负数 / 非整数 → 400。
    expect((await callAs(aliceToken, "POST", "/admin/access-keys", { name: "bad", daily_token_limit: -5 })).status).toBe(400);
    expect((await callAs(aliceToken, "PUT", `/admin/access-keys/${key.id}`, { max_concurrency: 1.5 })).status).toBe(400);
  });

  it("grants accept entry objects with budgets; plain strings stay unlimited", async () => {
    const { keyA, keyB, rootToken, alice } = await grantFixture();
    type GrantView = { provider_key_id: string; daily_token_limit: number; daily_request_limit: number };
    const grantsOf = async (): Promise<GrantView[]> => {
      const get = await callAs(rootToken, "GET", `/admin/users/${alice!.id}/grants`);
      return ((await get.json()) as { grants: GrantView[] }).grants;
    };

    // 新形状：条目对象带两个预算数字；缺省字段 = 0（不限）。
    const put = await callAs(rootToken, "PUT", `/admin/users/${alice!.id}/grants`, {
      provider_key_ids: [
        { provider_key_id: keyA, daily_token_limit: 300_000, daily_request_limit: 1000 },
        { provider_key_id: keyB },
      ],
    });
    expect(put.status).toBe(200);
    let grants = ((await put.json()) as { grants: GrantView[] }).grants;
    expect(grants.find((g) => g.provider_key_id === keyA)).toMatchObject({ daily_token_limit: 300_000, daily_request_limit: 1000 });
    expect(grants.find((g) => g.provider_key_id === keyB)).toMatchObject({ daily_token_limit: 0, daily_request_limit: 0 });

    // GET 展示同一限额。
    expect((await grantsOf()).find((g) => g.provider_key_id === keyA)).toMatchObject({ daily_token_limit: 300_000, daily_request_limit: 1000 });

    // 旧形状（纯字符串）向后兼容 = 不限额，整组替换覆盖之前的预算。
    const legacy = await callAs(rootToken, "PUT", `/admin/users/${alice!.id}/grants`, { provider_key_ids: [keyA, keyA, keyB] });
    expect(legacy.status).toBe(200);
    grants = ((await legacy.json()) as { grants: GrantView[] }).grants;
    expect(grants).toHaveLength(2);
    for (const g of grants) expect(g).toMatchObject({ daily_token_limit: 0, daily_request_limit: 0 });

    // 混合形状 + 去重（重复时后见覆盖）。
    const mixed = await callAs(rootToken, "PUT", `/admin/users/${alice!.id}/grants`, {
      provider_key_ids: [keyA, { provider_key_id: keyA, daily_token_limit: 9, daily_request_limit: 9 }],
    });
    grants = ((await mixed.json()) as { grants: GrantView[] }).grants;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ daily_token_limit: 9, daily_request_limit: 9 });

    // 非法预算 → 400，原集合不被破坏。
    expect((await callAs(rootToken, "PUT", `/admin/users/${alice!.id}/grants`, { provider_key_ids: [{ provider_key_id: keyA, daily_token_limit: -1 }] })).status).toBe(400);
    expect((await callAs(rootToken, "PUT", `/admin/users/${alice!.id}/grants`, { provider_key_ids: [{ provider_key_id: keyA, daily_request_limit: 1.5 }] })).status).toBe(400);
    expect((await grantsOf())).toHaveLength(1);

    // me/grants 视图同样带限额字段。
    const me = (await (await callAs(alice!.management_token!, "GET", "/admin/me/grants")).json()) as { grants: GrantView[] };
    expect(me.grants[0]).toMatchObject({ provider_key_id: keyA, daily_token_limit: 9, daily_request_limit: 9 });
  });

  it("config snapshot carries quota fields for all three levels (0 = unlimited)", async () => {
    const { keyA, rootToken, alice } = await grantFixture();
    await callAs(rootToken, "PUT", `/admin/keys/${keyA}`, { daily_token_limit: 777, daily_request_limit: 888 });
    await callAs(rootToken, "PUT", `/admin/users/${alice!.id}/grants`, {
      provider_key_ids: [{ provider_key_id: keyA, daily_token_limit: 55, daily_request_limit: 66 }],
    });
    const created = await callAs(alice!.management_token!, "POST", "/admin/access-keys", {
      name: "snap", daily_token_limit: 11, daily_request_limit: 22, max_concurrency: 3,
    });
    const keyId = ((await created.json()) as { id: string }).id;

    const config = await new SqlConfigStore(new D1AdminDb(db())).getActiveConfig();
    expect(config.keys.find((k) => k.id === keyA)).toMatchObject({ daily_token_limit: 777, daily_request_limit: 888 });
    expect(config.access_keys.find((k) => k.id === keyId)).toMatchObject({ daily_token_limit: 11, daily_request_limit: 22, max_concurrency: 3 });
    expect(config.grants.find((g) => g.user_id === alice!.id && g.provider_key_id === keyA)).toMatchObject({ daily_token_limit: 55, daily_request_limit: 66 });
    // 未设限额的授权 = 0（不限语义贯穿）。
    const otherGrants = config.grants.filter((g) => !(g.user_id === alice!.id && g.provider_key_id === keyA));
    for (const g of otherGrants) expect(g.daily_token_limit).toBe(0);
  });
});

// ---- 用量聚合（multi-user 05）---------------------------------------------------

interface UsageRow {
  ts: number;
  model: string;
  keyId: string | null;
  userId: string | null;
  prompt: number;
  completion: number;
  latency: number;
  status: number;
}

let usageSeq = 0;
async function seedUsage(rows: UsageRow[]): Promise<void> {
  for (const r of rows) {
    usageSeq++;
    await db().prepare(
      "INSERT INTO request_log (id, request_id, ts, client_model, provider_id, key_id, user_id, access_key_id, prompt_tokens, completion_tokens, latency_ms, status, error_type) "
        + "VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL)",
    )
      .bind(`V1StGXR8_Z5jdHi6B-u${String(usageSeq).padStart(3, "0")}`, `req-${usageSeq}`, r.ts, r.model, r.userId, r.keyId, r.prompt, r.completion, r.latency, r.status)
      .run();
  }
}

/** 两个用户、各自的访问 key id（request_log 无外键，直接造 21 字符 id）。 */
async function usageFixture() {
  const { rootToken, alice, bob } = await grantFixture();
  const aliceKey1 = "V1StGXR8_Z5jdHi6B-ak1";
  const aliceKey2 = "V1StGXR8_Z5jdHi6B-ak2";
  const bobKey = "V1StGXR8_Z5jdHi6B-bk1";
  await seedUsage([
    // alice / key1：两行成功 + 一行 5xx 错误。
    { ts: T0, model: "m1", keyId: aliceKey1, userId: alice!.id, prompt: 10, completion: 5, latency: 100, status: 200 },
    { ts: T0 + 1000, model: "m1", keyId: aliceKey1, userId: alice!.id, prompt: 20, completion: 10, latency: 300, status: 200 },
    { ts: T0 + 2000, model: "m2", keyId: aliceKey1, userId: alice!.id, prompt: 1, completion: 0, latency: 50, status: 502 },
    // alice / key2：一行成功。
    { ts: T0 + 3000, model: "m1", keyId: aliceKey2, userId: alice!.id, prompt: 7, completion: 3, latency: 40, status: 200 },
    // bob：一行成功（不在 alice 的视图里）。
    { ts: T0 + 4000, model: "m1", keyId: bobKey, userId: bob!.id, prompt: 99, completion: 99, latency: 999, status: 200 },
    // 无归属的历史行（管理员全局视图可见，user 视图不可见）。
    { ts: T0 + 5000, model: "m1", keyId: null, userId: null, prompt: 5, completion: 5, latency: 5, status: 200 },
  ]);
  return { rootToken, alice, bob, aliceKey1, aliceKey2, bobKey };
}

async function getUsage(query: string, token?: string): Promise<Response> {
  return callAs(token ?? "admin-secret", "GET", `/admin/usage${query}`);
}

describe("usage aggregation (multi-user 05)", () => {
  it("aggregates by access key and matches a manual accumulation of the log rows", async () => {
    const f = await usageFixture();
    const resp = await getUsage("?group_by=key", f.rootToken);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { usage: Array<Record<string, unknown>> };
    const byKey = new Map(body.usage.map((r) => [r.access_key_id, r]));
    // alice key1：3 请求 1 错误、tokens 31/15、平均 (100+300+50)/3 = 150。
    expect(byKey.get(f.aliceKey1)).toMatchObject({
      requests: 3, errors: 1, prompt_tokens: 31, completion_tokens: 15, avg_latency_ms: 150,
    });
    expect(byKey.get(f.aliceKey2)).toMatchObject({ requests: 1, errors: 0, prompt_tokens: 7, completion_tokens: 3, avg_latency_ms: 40 });
    expect(byKey.get(f.bobKey)).toMatchObject({ requests: 1, prompt_tokens: 99 });
  });

  it("groups by model, filters by time window and single access key", async () => {
    const f = await usageFixture();
    const byModel = (await (await getUsage("?group_by=model", f.rootToken)).json()) as { usage: Array<Record<string, unknown>> };
    const m1 = byModel.usage.find((r) => r.client_model === "m1")!;
    expect(m1).toMatchObject({ requests: 5, errors: 0, prompt_tokens: 141, completion_tokens: 122 });

    // 时间窗只含 T0+1000..T0+3000：alice key1 一行 m1 成功 + key2 一行 + m2 错误行。
    const windowed = (await (await getUsage(`?group_by=key&from=${T0 + 1000}&to=${T0 + 3000}`, f.rootToken)).json()) as { usage: Array<Record<string, unknown>> };
    const w1 = windowed.usage.find((r) => r.access_key_id === f.aliceKey1)!;
    expect(w1).toMatchObject({ requests: 2, errors: 1, prompt_tokens: 21 });

    // 单 key 过滤。
    const oneKey = (await (await getUsage(`?access_key_id=${f.aliceKey2}`, f.rootToken)).json()) as { usage: Array<Record<string, unknown>> };
    expect(oneKey.usage).toHaveLength(1);
    expect(oneKey.usage[0]).toMatchObject({ requests: 1, prompt_tokens: 7, completion_tokens: 3 });
  });

  it("scopes the user role to its own rows in SQL and rejects its user_id filter", async () => {
    const f = await usageFixture();
    const own = await getUsage("?group_by=key", f.alice!.management_token!);
    expect(own.status).toBe(200);
    const body = (await own.json()) as { usage: Array<Record<string, unknown>> };
    expect(body.usage.map((r) => r.access_key_id).sort()).toEqual([f.aliceKey1, f.aliceKey2].sort());
    // bob 的行与无归属历史行都不可见；数字只含自己的。
    expect(body.usage.reduce((s, r) => s + (r.prompt_tokens as number), 0)).toBe(38);

    // user_id 过滤参数仅 administrator 可用 → 403。
    const forbidden = await getUsage(`?user_id=${f.bob!.id}`, f.alice!.management_token!);
    expect(forbidden.status).toBe(403);

    // administrator 可按 user_id 过滤（含 bob 的行）。
    const bobOnly = (await (await getUsage(`?user_id=${f.bob!.id}`, f.rootToken)).json()) as { usage: Array<Record<string, unknown>> };
    expect(bobOnly.usage).toHaveLength(1);
    expect(bobOnly.usage[0]).toMatchObject({ requests: 1, prompt_tokens: 99 });
  });

  it("returns a zero-value structure for an empty window instead of erroring", async () => {
    const f = await usageFixture();
    const empty = await getUsage(`?from=${T0 + 100_000}&to=${T0 + 200_000}`, f.rootToken);
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({
      group_by: null,
      usage: [{ requests: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, avg_latency_ms: 0 }],
    });
    // 分组的空窗口返回空数组（零值结构），同样不报错。
    const groupedEmpty = (await (await getUsage(`?group_by=key&from=${T0 + 100_000}`, f.rootToken)).json()) as { usage: unknown[] };
    expect(groupedEmpty.usage).toEqual([]);
  });

  it("groups unattributed legacy rows under a null dimension in the admin global view", async () => {
    const f = await usageFixture();
    const body = (await (await getUsage("?group_by=key", f.rootToken)).json()) as { usage: Array<Record<string, unknown>> };
    const legacy = body.usage.find((r) => r.access_key_id === null);
    expect(legacy).toMatchObject({ requests: 1, prompt_tokens: 5, completion_tokens: 5 });
    // user 视图不含无归属行。
    const own = (await (await getUsage("?group_by=key", f.alice!.management_token!)).json()) as { usage: Array<Record<string, unknown>> };
    expect(own.usage.some((r) => r.access_key_id === null)).toBe(false);
  });

  it("requires management-plane auth and validates parameters", async () => {
    const f = await usageFixture();
    // 未认证（无 lgm_）：handleAdmin 统一 401。
    expect((await handleAdmin(new Request("http://gw/admin/usage"), adminDeps(ADMIN_ENV, true))).status).toBe(401);
    // lgk_ 不是管理面凭证 → 401（平面互斥）。
    expect((await handleAdmin(new Request("http://gw/admin/usage", { headers: { "x-admin-token": "lgk_x" } }), adminDeps(ADMIN_ENV, true))).status).toBe(401);

    expect((await getUsage("?group_by=nope", f.rootToken)).status).toBe(400);
    expect((await getUsage("?from=whenever", f.rootToken)).status).toBe(400);
    expect((await getUsage(`?to=soon`, f.rootToken)).status).toBe(400);
  });
});

// ---- 访问控制字段（access-control 01）--------------------------------------------

describe("access-control fields on admin API (access-control 01)", () => {
  const T1 = T0 + 7 * 86_400_000;

  interface AccessKeyView {
    id: string;
    expires_at: number;
    ip_allowlist: string[];
  }

  it("lgk_ create/update carries expires_at + ip_allowlist (self-service, echo, DB JSON)", async () => {
    const { user: root } = await createUser({ name: "root", role: "administrator" });
    const rootToken = root!.management_token!;
    const { user: alice } = await createUser({ name: "alice", role: "user" }, rootToken);
    const aliceToken = alice!.management_token!;

    // 自建带过期 + 双栈白名单，创建响应回显两字段。
    const created = await callAs(aliceToken, "POST", "/admin/access-keys", {
      name: "scene-1", expires_at: T1, ip_allowlist: ["10.0.0.0/8", "2001:db8::/32"],
    });
    expect(created.status).toBe(201);
    const key = (await created.json()) as AccessKeyView;
    expect(key.expires_at).toBe(T1);
    expect(key.ip_allowlist).toEqual(["10.0.0.0/8", "2001:db8::/32"]);
    const row = (await db().prepare("SELECT expires_at, ip_allowlist FROM access_key WHERE id = ?").bind(key.id)
      .all<{ expires_at: number; ip_allowlist: string }>()).results[0]!;
    expect(row.expires_at).toBe(T1);
    expect(JSON.parse(row.ip_allowlist)).toEqual(["10.0.0.0/8", "2001:db8::/32"]);

    // 自助更新自己的：清空白名单（= 不限），未提交的 expires_at 原样保留。
    const put = await callAs(aliceToken, "PUT", `/admin/access-keys/${key.id}`, { ip_allowlist: [] });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ id: key.id, expires_at: T1, ip_allowlist: [] });

    // 改他人的仍 404（归属谓词不变）；admin 可改任意。
    const { user: bob } = await createUser({ name: "bob", role: "user" }, rootToken);
    expect((await callAs(bob!.management_token!, "PUT", `/admin/access-keys/${key.id}`, { name: "hijack" })).status).toBe(404);
    const adminPut = await callAs(rootToken, "PUT", `/admin/access-keys/${key.id}`, { expires_at: 0 });
    expect(adminPut.status).toBe(200);
    expect(await adminPut.json()).toMatchObject({ id: key.id, expires_at: 0, ip_allowlist: [] });

    // 列表回显两字段。
    const list = (await (await callAs(rootToken, "GET", "/admin/access-keys")).json()) as AccessKeyView[];
    expect(list.find((k) => k.id === key.id)).toMatchObject({ expires_at: 0, ip_allowlist: [] });
  });

  it("rejects bad CIDR / negative / fractional access-control values with 400", async () => {
    const { user: root } = await createUser({ name: "root", role: "administrator" });
    const token = root!.management_token!;
    expect((await callAs(token, "POST", "/admin/access-keys", { name: "bad", ip_allowlist: ["10.0.0.0/33"] })).status).toBe(400);
    expect((await callAs(token, "POST", "/admin/access-keys", { name: "bad", ip_allowlist: ["not-a-cidr"] })).status).toBe(400);
    expect((await callAs(token, "POST", "/admin/access-keys", { name: "bad", ip_allowlist: ["2001:db8::/129"] })).status).toBe(400);
    expect((await callAs(token, "POST", "/admin/access-keys", { name: "bad", expires_at: -1 })).status).toBe(400);
    expect((await callAs(token, "POST", "/admin/access-keys", { name: "bad", expires_at: 1.5 })).status).toBe(400);
  });

  it("lgm_ reset accepts expires_at; PUT changes expiry only (token_hash untouched)", async () => {
    const { user: root } = await createUser({ name: "root", role: "administrator" });
    const rootToken = root!.management_token!;
    const { user: bob } = await createUser({ name: "bob", role: "user" }, rootToken);

    // 重置带 expires_at，响应回显。
    const reset = await callAs(rootToken, "POST", `/admin/users/${bob!.id}/token`, { expires_at: T1 });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ user_id: bob!.id, expires_at: T1 });
    let row = (await db().prepare("SELECT token_hash, expires_at, last_used_at FROM management_token WHERE user_id = ?").bind(bob!.id)
      .all<{ token_hash: string; expires_at: number; last_used_at: number }>()).results[0]!;
    expect(row.expires_at).toBe(T1);

    // 续期 ≠ 轮换：PUT 只改过期，哈希不变，响应无明文。
    const put = await callAs(rootToken, "PUT", `/admin/users/${bob!.id}/token`, { expires_at: 0 });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as Record<string, unknown>;
    expect(putBody).toMatchObject({ user_id: bob!.id, expires_at: 0 });
    expect(JSON.stringify(putBody)).not.toContain("lgm_");
    row = (await db().prepare("SELECT token_hash, expires_at, last_used_at FROM management_token WHERE user_id = ?").bind(bob!.id)
      .all<{ token_hash: string; expires_at: number; last_used_at: number }>()).results[0]!;
    expect(row.token_hash).toHaveLength(64);
    expect(row.expires_at).toBe(0);

    // user 角色不可操作用户资源 → 403；未知用户 404；缺 expires_at → 400。
    const { user: alice } = await createUser({ name: "alice", role: "user" }, rootToken);
    expect((await callAs(alice!.management_token!, "PUT", `/admin/users/${bob!.id}/token`, { expires_at: 0 })).status).toBe(403);
    expect((await callAs(alice!.management_token!, "POST", `/admin/users/${bob!.id}/token`, { expires_at: 0 })).status).toBe(403);
    expect((await callAs(rootToken, "PUT", "/admin/users/does-not-exist/token", { expires_at: 0 })).status).toBe(404);
    expect((await callAs(rootToken, "PUT", `/admin/users/${bob!.id}/token`, {})).status).toBe(400);
    expect((await callAs(rootToken, "PUT", `/admin/users/${bob!.id}/token`, { expires_at: -3 })).status).toBe(400);

    // 审计记录续期动作。
    const audit = (await (await callAs(rootToken, "GET", "/admin/audit")).json()) as Array<{ action: string; target: string }>;
    expect(audit.filter((a) => a.target === bob!.id).map((a) => a.action)).toContain("user.token.update");
  });

  it("user list carries token_expires_at / token_last_used_at", async () => {
    const { user: root } = await createUser({ name: "root", role: "administrator" });
    const rootToken = root!.management_token!;
    const { user: bob } = await createUser({ name: "bob", role: "user" }, rootToken);
    await callAs(rootToken, "POST", `/admin/users/${bob!.id}/token`, { expires_at: T1 });

    const list = (await (await callAs(rootToken, "GET", "/admin/users")).json()) as Array<{
      id: string; token_expires_at: number; token_last_used_at: number; token_hint: string;
    }>;
    expect(list.find((u) => u.id === bob!.id)).toMatchObject({ token_expires_at: T1, token_last_used_at: 0 });
    // 尾号列（access-control 03）：与重置响应的 token_hint 一致。
    expect(list.find((u) => u.id === root!.id)).toMatchObject({ token_hint: rootToken.slice(-4) });
    // root 的 token 刚被这些管理调用命中 → last_used_at = T0（02 起内联更新）。
    expect(list.find((u) => u.id === root!.id)).toMatchObject({ token_expires_at: 0, token_last_used_at: T0 });
    // 列表绝不携带 token 明文或哈希。
    expect(JSON.stringify(list)).not.toContain("lgm_");
    expect(JSON.stringify(list)).not.toContain("token_hash");
  });

  it("provider cooldown overrides persist and echo via POST/PUT", async () => {
    // 引导阶段直接建（虚拟管理员）。
    const created = await callAdmin("POST", "/admin/providers", {
      name: "p-cool", endpoints: { openai: "https://cool.test" },
      cooldown_failure_threshold: 5, cooldown_ms: 120_000,
    });
    expect(created.status).toBe(201);
    const provider = (await created.json()) as { id: string; cooldown_failure_threshold: number; cooldown_ms: number };
    expect(provider).toMatchObject({ cooldown_failure_threshold: 5, cooldown_ms: 120_000 });

    // 部分 PUT：只改 cooldown_ms，threshold 保留；0 = 回到全局默认。
    const put = await callAdmin("PUT", `/admin/providers/${provider.id}`, { cooldown_ms: 0 });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ cooldown_failure_threshold: 5, cooldown_ms: 0 });

    const list = (await (await callAdmin("GET", "/admin/providers")).json()) as Array<typeof provider>;
    expect(list.find((p) => p.id === provider.id)).toMatchObject({ cooldown_failure_threshold: 5, cooldown_ms: 0 });

    expect((await callAdmin("POST", "/admin/providers", { name: "bad", endpoints: { openai: "https://x.test" }, cooldown_ms: -1 })).status).toBe(400);
    expect((await callAdmin("PUT", `/admin/providers/${provider.id}`, { cooldown_failure_threshold: 1.5 })).status).toBe(400);
  });

  it("config snapshot carries lgk_ expires_at and parsed ip_allowlist", async () => {
    const { user: root } = await createUser({ name: "root", role: "administrator" });
    const rootToken = root!.management_token!;
    const { user: alice } = await createUser({ name: "alice", role: "user" }, rootToken);
    const key = (await (await callAs(alice!.management_token!, "POST", "/admin/access-keys", {
      name: "snap", expires_at: T1, ip_allowlist: ["192.168.0.0/16", "fe80::/10"],
    })).json()) as { id: string };

    const config1 = await new SqlConfigStore(new D1AdminDb(env.DB)).getActiveConfig();
    expect(config1.access_keys.find((k) => k.id === key.id)).toMatchObject({
      expires_at: T1,
      ip_allowlist: ["192.168.0.0/16", "fe80::/10"],
    });
    // 未设置两字段的 key 落默认值（0 / []）。
    const plain = (await (await callAs(alice!.management_token!, "POST", "/admin/access-keys", { name: "plain" })).json()) as { id: string };
    const config2 = await new SqlConfigStore(new D1AdminDb(env.DB)).getActiveConfig();
    expect(config2.access_keys.find((k) => k.id === plain.id)).toMatchObject({ expires_at: 0, ip_allowlist: [] });
  });
});

describe("admin keys cooldown reset (异常恢复)", () => {
  it("PUT { reset_cooldown: true } clears cooldown_until and failure_count; other patches keep them", async () => {
    const prov = await createProvider("p-cool");
    const createKey = async () => {
      const resp = await callAdmin("POST", "/admin/keys", { provider_id: prov.id, api_key: "sk-cool-abcdef" });
      expect(resp.status).toBe(201);
      return (await resp.json()) as { id: string };
    };

    // 直接灌异常态（未来冷却 + 失败计数）。
    const k1 = await createKey();
    await db().prepare("UPDATE provider_key SET cooldown_until = ?, failure_count = 5 WHERE id = ?")
      .bind(T0 + 60_000, k1.id).run();

    // 其他字段 patch（enabled）不触碰冷却/失败计数。
    await callAdmin("PUT", `/admin/keys/${k1.id}`, { enabled: false });
    const afterToggle = await db().prepare("SELECT enabled, cooldown_until, failure_count FROM provider_key WHERE id = ?")
      .bind(k1.id).first<{ enabled: number; cooldown_until: number; failure_count: number }>();
    expect(afterToggle).toMatchObject({ enabled: 0, cooldown_until: T0 + 60_000, failure_count: 5 });

    // reset_cooldown：两者同时清零（审计记录 key.update）。
    const resp = await callAdmin("PUT", `/admin/keys/${k1.id}`, { reset_cooldown: true });
    expect(resp.status).toBe(200);
    const row = await db().prepare("SELECT cooldown_until, failure_count FROM provider_key WHERE id = ?")
      .bind(k1.id).first<{ cooldown_until: number; failure_count: number }>();
    expect(row).toMatchObject({ cooldown_until: 0, failure_count: 0 });
    // 审计记录（audit id 为随机串，按 action+target 查存在性而非排序取尾）。
    const audit = await db().prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'key.update' AND target = ?")
      .bind(k1.id).first<{ n: number }>();
    expect(audit!.n).toBeGreaterThan(0);
  });
});
