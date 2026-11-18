import { describe, expect, it } from "bun:test";
import { restoreBackup, type BackupEnvelope, type RestoreResult } from "./restore";

/**
 * 备份重放（desktop 06）：核心逻辑为可注入 fetch 的纯模块——测试用假路由
 * 验证外部行为（预检冲突、重放顺序、临时凭证、手动清单），不碰真实网关。
 */

const BASE = "http://gw.test";

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 假网关路由：空/非空目标库可配；POST/PUT 造新 id 并记录调用序。 */
function fakeGateway(target: {
  providers?: Array<{ id: string; name: string }>;
  keys?: Array<{ id: string }>;
  mappings?: Array<{ id: string; client_model: string; upstream_model: string }>;
  users?: Array<{ id: string; name: string }>;
} = {}) {
  const requests: Recorded[] = [];
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;
  const decryptCalls: string[] = [];
  const created = {
    providers: new Map<string, string>(), // 备份 id → 新 id
    keys: new Map<string, string>(),
    users: new Map<string, string>(),
  };
  const grantsCalls: Array<{ userId: string; body: unknown }> = [];

  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = url.slice(BASE.length);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ method, path, body });

    if (method === "GET") {
      if (path === "/admin/providers") return jsonResponse(target.providers ?? []);
      if (path === "/admin/keys") return jsonResponse(target.keys ?? []);
      if (path === "/admin/mappings") return jsonResponse(target.mappings ?? []);
      if (path === "/admin/users") return jsonResponse(target.users ?? []);
      return jsonResponse({ error: { code: "NOT_FOUND" } }, 404);
    }

    if (method === "POST" && path === "/admin/providers") {
      const id = nextId("np");
      created.providers.set((body as { name: string }).name, id);
      return jsonResponse({ id, ...(body as object) }, 201);
    }
    if (method === "POST" && path === "/admin/keys") {
      const id = nextId("nk");
      created.keys.set(String(seq), id);
      return jsonResponse({ id }, 201);
    }
    if (method === "POST" && path === "/admin/mappings") return jsonResponse({ id: nextId("nm") }, 201);
    if (method === "POST" && path === "/admin/users") {
      const id = nextId("nu");
      created.users.set((body as { name: string }).name, id);
      return jsonResponse({ id, name: (body as { name: string }).name, management_token: `lgm_temp_${id}` }, 201);
    }
    if (method === "PUT" && path.endsWith("/grants")) {
      grantsCalls.push({ userId: path.split("/")[3]!, body });
      return jsonResponse({ user_id: path.split("/")[3]!, grants: [] });
    }
    if (method === "PUT" && path.startsWith("/admin/users/")) return jsonResponse({});
    return jsonResponse({ error: { code: "NOT_FOUND" } }, 404);
  };

  return { fetcher, requests, created, grantsCalls, decryptCalls };
}

const decrypt = async (encrypted: string) => {
  return `decrypted(${encrypted})`;
};

function backup(): BackupEnvelope {
  return {
    version: 1,
    exported_at: 1_731_024_000_000,
    providers: [
      { id: "p1", name: "openai", type: "custom", enabled: 1, weight: 2, cooldown_failure_threshold: 5, cooldown_ms: 120_000, endpoints: { openai: "https://a.test" } },
    ],
    keys: [
      { id: "k1", provider_id: "p1", encrypted_key: "ENC-1", key_hint: "cret", enabled: 1, daily_token_limit: 1000, daily_request_limit: 2000 },
    ],
    mappings: [
      { id: "m1", client_model: "m1", provider_id: "p1", upstream_model: "gpt-4o", enabled: 1 },
    ],
    users: [
      { id: "u-alice", name: "alice", role: "user", enabled: 1 },
      { id: "u-root", name: "root", role: "administrator", enabled: 0 },
    ],
    grants: [
      { id: "gr1", user_id: "u-alice", provider_key_id: "k1", daily_token_limit: 7000, daily_request_limit: 8000 },
    ],
    access_keys: [{ id: "ak1", user_id: "u-alice", name: "scene", key_hint: "cret" }],
    audit: [{ id: "au1", ts: 1, action: "provider.create" }],
  };
}

function depsOf(fake: ReturnType<typeof fakeGateway>) {
  return {
    baseUrl: BASE,
    adminToken: "lgm_admin",
    fetcher: fake.fetcher,
    decrypt,
  };
}

describe("restoreBackup (desktop 06)", () => {
  it("replays the full chain onto an empty target in order: providers → keys → mappings → users → grants", async () => {
    const fake = fakeGateway(); // 空库
    const result = await restoreBackup(backup(), depsOf(fake));

    expect(result.status).toBe("replayed");
    expect(result.conflicts).toEqual([]);

    // 写请求顺序（GET 预检在前，断言剔除）。
    const writes = fake.requests.filter((r) => r.method !== "GET");
    expect(writes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /admin/providers",
      "POST /admin/keys",
      "POST /admin/mappings",
      "POST /admin/users", // alice
      "POST /admin/users", // root（停用）
      "PUT /admin/users/nu-5", // root 补 enabled=false
      "PUT /admin/users/nu-4/grants", // alice 的授权（含配额）
    ]);

    // key 解密缝：密文进、明文作为 api_key 重放（目标库用同一把 key 再加密）。
    const keyPost = writes.find((r) => r.path === "/admin/keys")!.body as { api_key: string; provider_id: string; enabled: boolean };
    expect(keyPost).toMatchObject({ api_key: "decrypted(ENC-1)", enabled: true });
    // provider_id 已按新 id 翻译。
    expect(keyPost.provider_id).toBe(result.idMap.providers["p1"]!);

    // 授权：provider_key_id 翻译 + 配额随行。
    expect(fake.grantsCalls).toHaveLength(1);
    expect(fake.grantsCalls[0]!.userId).toBe(result.idMap.users["u-alice"]!);
    expect(fake.grantsCalls[0]!.body).toEqual({
      provider_key_ids: [
        { provider_key_id: result.idMap.keys["k1"]!, daily_token_limit: 7000, daily_request_limit: 8000 },
      ],
    });

    // 临时凭证：每个用户一份 lgm_（仅此一次打印）。
    expect(result.tempCredentials.map((c) => c.name)).toEqual(["alice", "root"]);
    expect(result.tempCredentials.every((c) => c.management_token.startsWith("lgm_"))).toBe(true);

    // 手动清单覆盖三大件。
    const manual = result.manualSteps.join("\n");
    expect(manual).toContain("lgm_");
    expect(manual).toContain("lgk_");
    expect(manual).toContain("ENCRYPTION_KEY");
  });

  it("aborts with a full conflict list and zero writes when the target has id/name clashes", async () => {
    const fake = fakeGateway({
      providers: [{ id: "p9", name: "openai" }], // 同名 provider
      keys: [{ id: "k1" }], // 同 id key
      mappings: [{ id: "mx", client_model: "m1", upstream_model: "gpt-4o" }], // 同 client_model → upstream 映射对
      users: [{ id: "u-evil", name: "alice" }], // 同名用户
    });
    const result = await restoreBackup(backup(), depsOf(fake));

    expect(result.status).toBe("aborted");
    // 完整冲突清单：四类各一条，标注资源与原因。
    expect(result.conflicts).toHaveLength(4);
    expect(result.conflicts).toContainEqual({ resource: "provider", backup_id: "p1", detail: 'name "openai" already exists' });
    expect(result.conflicts).toContainEqual({ resource: "provider_key", backup_id: "k1", detail: "id already exists" });
    expect(result.conflicts).toContainEqual({ resource: "model_mapping", backup_id: "m1", detail: 'client_model "m1" → "gpt-4o" already exists' });
    expect(result.conflicts).toContainEqual({ resource: "user", backup_id: "u-alice", detail: 'name "alice" already exists' });
    // 零写入：预检只发 GET。
    expect(fake.requests.map((r) => r.method)).toEqual(["GET", "GET", "GET", "GET"]);
    expect(result.tempCredentials).toEqual([]);
  });

  it("rejects unknown envelope versions", async () => {
    const fake = fakeGateway();
    const bad = { ...backup(), version: 99 };
    let threw = "";
    try {
      await restoreBackup(bad as BackupEnvelope, depsOf(fake));
    } catch (err) {
      threw = String(err);
    }
    expect(threw).toContain("version");
    expect(fake.requests).toEqual([]); // 版本拒识在预检之前
  });

  it("decrypts key management credentials and replays them as plaintext objects (provider-usage 04)", async () => {
    const fake = fakeGateway();
    const b = backup();
    b.keys[0]!.management_credentials = "ENC-CREDS";
    // 凭证密文解出的是 JSON 串（服务端加密前的明文形态）。
    const deps = {
      ...depsOf(fake),
      decrypt: async (encrypted: string) =>
        encrypted === "ENC-CREDS"
          ? JSON.stringify({ type: "volcengine_ak_sk", access_key_id: "AK", secret_access_key: "SK" })
          : `decrypted(${encrypted})`,
    };
    const result = await restoreBackup(b, deps);
    expect(result.status).toBe("replayed");

    const keyPost = fake.requests.find((r) => r.method === "POST" && r.path === "/admin/keys")!.body as {
      management_credentials?: unknown;
    };
    // 密文经 decrypt 缝还原为明文对象（目标库 POST 时再加密）；api_key 正常解密重放。
    expect(keyPost.management_credentials).toEqual({ type: "volcengine_ak_sk", access_key_id: "AK", secret_access_key: "SK" });
    expect((keyPost as { api_key: string }).api_key).toBe("decrypted(ENC-1)");
  });

  it("throws when a key carries management credentials but no decrypt function is provided", async () => {
    const fake = fakeGateway();
    const b = backup();
    b.keys[0]!.management_credentials = "ENC-CREDS";
    const deps = { ...depsOf(fake), decrypt: undefined };
    let threw = "";
    try {
      await restoreBackup(b, deps as typeof deps);
    } catch (err) {
      threw = String(err);
    }
    expect(threw).toContain("decrypt function");
    // 预检通过后才在重放阶段抛错（providers 已写入，keys 中止）。
    expect(fake.requests.filter((r) => r.method === "POST" && r.path === "/admin/keys")).toHaveLength(0);
  });
});
