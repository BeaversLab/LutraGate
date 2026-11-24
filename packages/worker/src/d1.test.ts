import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { CachedConfigStore, SqlConfigStore } from "@lutragate/core";
import { D1AdminDb } from "./d1";
import { decryptApiKey, encryptApiKey, importEncryptionKey } from "@lutragate/core";
import { createHandler } from "./index";
import { InMemoryKeyState, sha256Hex } from "@lutragate/core";
import type { Fetcher } from "@lutragate/core";
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

// 32-byte zero key in base64 (test only).
const TEST_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PLAINTEXT_KEY = "sk-live-plaintext-secret";
const T0 = 1_731_024_000_000;
// 数据面身份（multi-user 04）：单用户 + 一把 lgk_ + 对种子 key 的授权。
const LGK = "lgk_d1-test-access-key-01";
const UID = "V1StGXR8_Z5jdHi6B-us1";
const AKID = "V1StGXR8_Z5jdHi6B-ak1";

function db(): D1Database {
  if (!env.DB) throw new Error("D1 binding DB missing");
  return env.DB;
}

async function insertProvider(id: string, name: string, enabled = 1): Promise<void> {
  await db()
    .prepare(
      "INSERT INTO provider (id, name, type, enabled, weight, created_at, updated_at) VALUES (?, ?, 'custom', ?, 1, ?, ?)",
    )
    .bind(id, name, enabled, T0, T0)
    .run();
  await db()
    .prepare("INSERT INTO provider_endpoint (id, provider_id, protocol, base_url) VALUES (?, ?, 'openai', ?)")
    .bind(`ep-${id}`, id, `https://${name}.test`)
    .run();
}

async function seed(): Promise<{ providerId: string; keyId: string; encryptedKey: string }> {
  const providerId = "V1StGXR8_Z5jdHi6B-myA";
  const keyId = "V1StGXR8_Z5jdHi6B-myC";
  const mappingId = "V1StGXR8_Z5jdHi6B-myF";
  const cryptoKey = await importEncryptionKey(TEST_ENCRYPTION_KEY);
  const encryptedKey = await encryptApiKey(cryptoKey, PLAINTEXT_KEY);

  await db()
    .batch([
      db().prepare(
        "INSERT INTO provider (id, name, type, enabled, weight, created_at, updated_at) VALUES (?, 'p-a', 'custom', 1, 1, ?, ?)",
      ).bind(providerId, T0, T0),
      db().prepare(
        "INSERT INTO provider_endpoint (id, provider_id, protocol, base_url) VALUES ('ep-p-a', ?, 'openai', 'https://a.test')",
      ).bind(providerId),
      db().prepare(
        "INSERT INTO provider_key (id, provider_id, encrypted_key, key_hint, enabled, cooldown_until, failure_count, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?)",
      ).bind(keyId, providerId, encryptedKey, PLAINTEXT_KEY.slice(-4), T0, T0),
      db().prepare(
        "INSERT INTO model_mapping (id, client_model, provider_id, upstream_model, enabled) VALUES (?, ?, ?, ?, 1)",
      ).bind(mappingId, "m1", providerId, "a-up"),
      db().prepare(
        "INSERT INTO user (id, name, role, enabled, created_at, updated_at) VALUES (?, 'alice', 'user', 1, ?, ?)",
      ).bind(UID, T0, T0),
      db().prepare(
        "INSERT INTO access_key (id, user_id, name, key_hash, key_hint, enabled, created_at, updated_at) VALUES (?, ?, 'seed', ?, ?, 1, ?, ?)",
      ).bind(AKID, UID, await sha256Hex(LGK), LGK.slice(-4), T0, T0),
      db().prepare(
        "INSERT INTO user_key_grant (id, user_id, provider_key_id, created_at) VALUES ('V1StGXR8_Z5jdHi6B-gr1', ?, ?, ?)",
      ).bind(UID, keyId, T0),
    ]);
  return { providerId, keyId, encryptedKey };
}

beforeAll(async () => {
  // Apply the migration DDL (statements contain no embedded semicolons).
  const statements = [migrationSql, migration2Sql, migration3Sql, migration4Sql, migration5Sql, migration6Sql, migration7Sql, migration8Sql, migration9Sql, migration10Sql, migration11Sql, migration12Sql, migration13Sql].join(";").split(";").map((s) => s.trim()).filter(Boolean);
  await db().batch(statements.map((s) => db().prepare(s)));
});

beforeEach(async () => {
  await db().batch([
    db().prepare("DELETE FROM request_log"),
    db().prepare("DELETE FROM admin_audit"),
    db().prepare("DELETE FROM model_mapping"),
    db().prepare("DELETE FROM user_key_grant"),
    db().prepare("DELETE FROM access_key"),
    db().prepare("DELETE FROM user"),
    db().prepare("DELETE FROM provider_key"),
    db().prepare("DELETE FROM provider"),
  ]);
});

describe("migration + D1ConfigStore", () => {
  it("maps D1 rows onto GatewayConfig (booleans, hints, no plaintext)", async () => {
    const { providerId } = await seed();
    const config = await new SqlConfigStore(new D1AdminDb(db())).getActiveConfig();

    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]).toMatchObject({ id: providerId, name: "p-a", enabled: true, weight: 1 });
    expect(config.keys[0]).toMatchObject({
      provider_id: providerId,
      key_hint: PLAINTEXT_KEY.slice(-4),
      enabled: true,
      cooldown_until: 0,
    });
    expect(config.mappings[0]).toMatchObject({ client_model: "m1", upstream_model: "a-up", enabled: true });

    // No plaintext key in the database.
    const row = await db().prepare("SELECT encrypted_key FROM provider_key").first<{ encrypted_key: string }>();
    expect(row!.encrypted_key).not.toContain(PLAINTEXT_KEY);
    expect(row!.encrypted_key).not.toBe(PLAINTEXT_KEY);
  });

  it("round-trips AES-GCM encryption (encryptApiKey/decryptApiKey)", async () => {
    const cryptoKey = await importEncryptionKey(TEST_ENCRYPTION_KEY);
    const payload = await encryptApiKey(cryptoKey, PLAINTEXT_KEY);
    await expect(decryptApiKey(cryptoKey, payload)).resolves.toBe(PLAINTEXT_KEY);
  });

  it("rejects ENCRYPTION_KEY secrets that are not 32 bytes", async () => {
    await expect(importEncryptionKey(btoa("short"))).rejects.toThrow(/32 bytes/);
  });
});

describe("CachedConfigStore", () => {
  it("serves the cached config within the TTL and refreshes after expiry", async () => {
    let now = 1_000_000;
    const inner = new SqlConfigStore(new D1AdminDb(db()));
    const store = new CachedConfigStore(inner, { ttlMs: 30_000, now: () => now });

    await seed();
    const first = await store.getActiveConfig();
    expect(first.providers).toHaveLength(1);

    // Write a second provider; cache still warm.
    await insertProvider("V1StGXR8_Z5jdHi6B-myB", "p-b");
    expect((await store.getActiveConfig()).providers).toHaveLength(1);

    // TTL expiry picks the row up without explicit invalidation.
    now += 30_001;
    expect((await store.getActiveConfig()).providers).toHaveLength(2);
  });

  it("invalidate() refreshes immediately after writes (PRD F2.5)", async () => {
    const inner = new SqlConfigStore(new D1AdminDb(db()));
    const store = new CachedConfigStore(inner, { ttlMs: 30_000, now: () => 1_000_000 });
    await seed();
    await store.getActiveConfig();

    await insertProvider("V1StGXR8_Z5jdHi6B-myB", "p-b");
    store.invalidate();
    expect((await store.getActiveConfig()).providers).toHaveLength(2);
  });
});

describe("/v1/models", () => {
  it("lists deduplicated client models from enabled mappings", async () => {
    await seed();
    // Second mapping: same client model on another provider (dedup)…
    await db().batch([
      db().prepare("INSERT INTO provider (id, name, type, enabled, weight, created_at, updated_at) VALUES (?, 'p-b', 'custom', 1, 1, ?, ?)").bind("V1StGXR8_Z5jdHi6B-myB", T0, T0),
      db().prepare("INSERT INTO provider_endpoint (id, provider_id, protocol, base_url) VALUES ('ep-p-b', 'V1StGXR8_Z5jdHi6B-myB', 'openai', 'https://b.test')"),
      db().prepare("INSERT INTO model_mapping (id, client_model, provider_id, upstream_model, enabled) VALUES (?, ?, ?, ?, 1)")
        .bind("V1StGXR8_Z5jdHi6B-myG", "m1", "V1StGXR8_Z5jdHi6B-myB", "b-up"),
      // …and a disabled mapping for another model (excluded).
      db().prepare("INSERT INTO model_mapping (id, client_model, provider_id, upstream_model, enabled) VALUES (?, ?, ?, ?, 0)")
        .bind("V1StGXR8_Z5jdHi6B-myH", "m2", "V1StGXR8_Z5jdHi6B-myA", "a-up2"),
    ]);

    const handler = createHandler({
      configStore: new CachedConfigStore(new SqlConfigStore(new D1AdminDb(db()))),
    });
    const resp = await handler(
      new Request("http://gw/v1/models", { headers: { authorization: `Bearer ${LGK}` } }),
      {},
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({
      object: "list",
      data: [{ id: "m1", object: "model", owned_by: "lutragate" }],
    });
  });

  it("requires auth like every /v1/* route", async () => {
    const handler = createHandler({ configStore: new CachedConfigStore(new SqlConfigStore(new D1AdminDb(db()))) });
    const resp = await handler(new Request("http://gw/v1/models"), {});
    expect(resp.status).toBe(401);
  });

  it("excludes models whose only provider is disabled", async () => {
    await seed();
    await insertProvider("V1StGXR8_Z5jdHi6B-myB", "p-b", 0); // disabled
    await db()
      .prepare("INSERT INTO model_mapping (id, client_model, provider_id, upstream_model, enabled) VALUES (?, ?, ?, ?, 1)")
      .bind("V1StGXR8_Z5jdHi6B-myI", "m3", "V1StGXR8_Z5jdHi6B-myB", "b-up")
      .run();

    const handler = createHandler({
      configStore: new CachedConfigStore(new SqlConfigStore(new D1AdminDb(db()))),
    });
    const resp = await handler(
      new Request("http://gw/v1/models", { headers: { authorization: `Bearer ${LGK}` } }),
      {},
    );
    const body = (await resp.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(["m1"]); // m3 hidden
  });
});

describe("proxy path with D1 config and encrypted keys", () => {
  it("fails loudly when D1 is bound but ENCRYPTION_KEY is missing", async () => {
    await seed();
    const handler = createHandler({ fetcher: { fetch: async () => new Response("{}") } });
    const resp = await handler(
      new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${LGK}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "m1" }),
      }),
      { DB: db() }, // ENCRYPTION_KEY deliberately absent
    );
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain("ENCRYPTION_KEY");
  });

  it("decrypts the key at forward time and sends it upstream", async () => {
    await seed();
    const requests: Request[] = [];
    const fetcher: Fetcher = {
      async fetch(req: Request): Promise<Response> {
        requests.push(req.clone());
        return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
      },
    };

    const handler = createHandler({
      fetcher,
      keyState: new InMemoryKeyState(),
      clock: { now: () => 0 },
      rng: () => 0,
      // Logging is covered in logging.test.ts; a no-op sink keeps this test
      // free of fire-and-forget D1 writes (isolated-storage snapshot races).
      logSink: { write: () => undefined },
    });
    const resp = await handler(
      new Request("http://gw/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${LGK}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "m1", messages: [] }),
      }),
      { DB: db(), ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
    );
    expect(resp.status).toBe(200);
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${PLAINTEXT_KEY}`);
    expect(requests[0]!.url).toBe("https://a.test/v1/chat/completions");
  });
});
