import { describe, expect, it } from "vitest";
import {
  activeEnvOf,
  defaultGatewayUrl,
  deleteEnvTokenEverywhere,
  emptyEnvState,
  envTokenKey,
  loadEnvState,
  loadEnvToken,
  loadEnvTokenSecure,
  newEnvId,
  normalizeBaseUrl,
  removeEnv,
  saveEnvState,
  saveEnvToken,
  saveEnvTokenSecure,
  setActiveEnv,
  upsertEnv,
  type EnvRecord,
  type EnvStoreState,
  type StorageLike,
} from "./envs";
import type { SecretStore } from "./secrets";

function memoryStorage(): StorageLike {
  const map: Record<string, string> = {};
  return {
    getItem: (k) => map[k] ?? null,
    setItem: (k, v) => {
      map[k] = v;
    },
  };
}

function env(id: string, name: string, gatewayUrl = "http://gw.test"): EnvRecord {
  return { id, name, gatewayUrl };
}

describe("env state storage", () => {
  it("round-trips the environment list and active marker through storage", () => {
    const storage = memoryStorage();
    const state: EnvStoreState = { environments: [env("e1", "家里"), env("e2", "公司")], activeEnvId: "e2" };
    saveEnvState(storage, state);
    expect(loadEnvState(storage)).toEqual(state);
  });

  it("returns an empty state when storage is empty, corrupted, or has wrong types", () => {
    expect(loadEnvState(memoryStorage())).toEqual(emptyEnvState());

    const broken = memoryStorage();
    broken.setItem("lutragate.environments", "{not json");
    expect(loadEnvState(broken)).toEqual(emptyEnvState());

    const wrongTypes = memoryStorage();
    wrongTypes.setItem("lutragate.environments", JSON.stringify({ environments: [{ id: 42 }], activeEnvId: 9 }));
    // 行形状不对 → 整行丢弃，活跃标记随之置空。
    expect(loadEnvState(wrongTypes)).toEqual(emptyEnvState());
  });

  it("self-heals a dangling activeEnvId that points at a missing environment", () => {
    const storage = memoryStorage();
    storage.setItem(
      "lutragate.environments",
      JSON.stringify({ environments: [env("e1", "家里")], activeEnvId: "gone" }),
    );
    expect(loadEnvState(storage)).toEqual({ environments: [env("e1", "家里")], activeEnvId: null });
  });
});

describe("env list operations (pure)", () => {
  it("activates the first environment created from an empty list (bootstrap)", () => {
    const created = upsertEnv(emptyEnvState(), env("e1", "家里"));
    expect(created).toEqual({ environments: [env("e1", "家里")], activeEnvId: "e1" });
    expect(activeEnvOf(created)).toEqual(env("e1", "家里"));
  });

  it("inserting a second environment keeps the current active one", () => {
    const state: EnvStoreState = { environments: [env("e1", "家里")], activeEnvId: "e1" };
    const next = upsertEnv(state, env("e2", "公司"));
    expect(next.environments.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(next.activeEnvId).toBe("e1");
  });

  it("updates name and gatewayUrl in place without disturbing the list order or active marker", () => {
    const state: EnvStoreState = { environments: [env("e1", "家里"), env("e2", "公司")], activeEnvId: "e2" };
    const next = upsertEnv(state, env("e2", "公司新名", "http://new.test"));
    expect(next.environments).toEqual([env("e1", "家里"), env("e2", "公司新名", "http://new.test")]);
    expect(next.activeEnvId).toBe("e2");
  });

  it("setActiveEnv switches within known ids and ignores unknown ones", () => {
    const state: EnvStoreState = { environments: [env("e1", "家里"), env("e2", "公司")], activeEnvId: "e1" };
    expect(setActiveEnv(state, "e2").activeEnvId).toBe("e2");
    expect(setActiveEnv(state, "nope")).toEqual(state);
  });

  it("removing the active environment falls back to the first remaining, then to none", () => {
    const state: EnvStoreState = { environments: [env("e1", "家里"), env("e2", "公司")], activeEnvId: "e1" };
    const after = removeEnv(state, "e1");
    expect(after).toEqual({ environments: [env("e2", "公司")], activeEnvId: "e2" });
    expect(removeEnv(after, "e2")).toEqual(emptyEnvState());
  });
});

describe("env identity", () => {
  it("generates stable-looking unique ids that do not derive from any URL", () => {
    const a = newEnvId();
    const b = newEnvId();
    expect(a).not.toBe(b);
    expect(a).not.toContain("http");
  });
});

describe("token slots (web plaintext)", () => {
  it("stores tokens per environment without cross-talk", () => {
    const storage = memoryStorage();
    saveEnvToken(storage, "e1", "lgm_home");
    saveEnvToken(storage, "e2", "lgm_work");
    expect(loadEnvToken(storage, "e1")).toBe("lgm_home");
    expect(loadEnvToken(storage, "e2")).toBe("lgm_work");

    saveEnvToken(storage, "e1", "");
    expect(loadEnvToken(storage, "e1")).toBe("");
    expect(loadEnvToken(storage, "e2")).toBe("lgm_work");
  });

  it("keeps tokens out of the environment list persisted to storage", () => {
    const storage = memoryStorage();
    saveEnvState(storage, upsertEnv(emptyEnvState(), env("e1", "家里")));
    saveEnvToken(storage, "e1", "lgm_secret");
    expect(storage.getItem("lutragate.environments")).not.toContain("lgm_secret");
  });
});

describe("token slots (desktop secure)", () => {
  it("derives the Keychain slot name per environment", () => {
    expect(envTokenKey("e1")).toBe("management-token:e1");
  });

  /** 内存版 SecretStore：可模拟 Keychain 不可用（各操作抛错）并记录调用。 */
  function fakeSecretStore(opts: { failGet?: boolean; failSet?: boolean; failDelete?: boolean } = {}) {
    const map = new Map<string, string>();
    const calls: string[] = [];
    const store: SecretStore = {
      get: async (key) => {
        calls.push(`get:${key}`);
        if (opts.failGet) throw new Error("keychain unavailable");
        return map.get(key) ?? null;
      },
      set: async (key, value) => {
        calls.push(`set:${key}:${value}`);
        if (opts.failSet) throw new Error("keychain write failed");
        map.set(key, value);
      },
      delete: async (key) => {
        calls.push(`delete:${key}`);
        if (opts.failDelete) throw new Error("keychain delete failed");
        map.delete(key);
      },
    };
    return { store, calls, peek: (k: string) => map.get(k) ?? null };
  }

  it("loads the token from its per-environment Keychain slot and scrubs plaintext residue", async () => {
    const storage = memoryStorage();
    saveEnvToken(storage, "e1", "lgm_stale");
    const { store, peek } = fakeSecretStore();
    await store.set(envTokenKey("e1"), "lgm_secure");

    const state = await loadEnvTokenSecure(store, storage, "e1");

    expect(state).toEqual({ token: "lgm_secure", degraded: false });
    // 安全副本在位：localStorage 不留双份秘密。
    expect(loadEnvToken(storage, "e1")).toBe("");
    expect(peek(envTokenKey("e1"))).toBe("lgm_secure");
  });

  it("keeps environments in separate slots — one env's token never leaks into another", async () => {
    const storage = memoryStorage();
    const { store } = fakeSecretStore();
    await saveEnvTokenSecure(store, storage, "e1", "lgm_home");
    await saveEnvTokenSecure(store, storage, "e2", "lgm_work");

    expect(await loadEnvTokenSecure(store, storage, "e1")).toEqual({ token: "lgm_home", degraded: false });
    expect(await loadEnvTokenSecure(store, storage, "e2")).toEqual({ token: "lgm_work", degraded: false });
  });

  it("degrades to the plaintext copy with a persistent warning when the Keychain is unavailable", async () => {
    const storage = memoryStorage();
    saveEnvToken(storage, "e1", "lgm_plain");
    const { store } = fakeSecretStore({ failGet: true });

    const state = await loadEnvTokenSecure(store, storage, "e1");

    expect(state).toEqual({ token: "lgm_plain", degraded: true });
  });

  it("returns an empty non-degraded state when nothing is stored anywhere", async () => {
    const { store } = fakeSecretStore();
    expect(await loadEnvTokenSecure(store, memoryStorage(), "e1")).toEqual({ token: "", degraded: false });
  });

  it("saves into the per-env Keychain slot and keeps localStorage secret-free", async () => {
    const storage = memoryStorage();
    const { store, peek } = fakeSecretStore();

    const result = await saveEnvTokenSecure(store, storage, "e1", "lgm_next");

    expect(result).toEqual({ degraded: false });
    expect(peek(envTokenKey("e1"))).toBe("lgm_next");
    expect(loadEnvToken(storage, "e1")).toBe("");
  });

  it("falls back to plaintext localStorage and flags degraded when the Keychain write fails", async () => {
    const storage = memoryStorage();
    const { store } = fakeSecretStore({ failSet: true });

    const result = await saveEnvTokenSecure(store, storage, "e1", "lgm_plain");

    expect(result).toEqual({ degraded: true });
    // 降级副本仍可被下次启动读到（不丢登录），且首写恢复路径会把它迁回 Keychain。
    expect(loadEnvToken(storage, "e1")).toBe("lgm_plain");
    expect((await loadEnvTokenSecure(store, storage, "e1")).degraded).toBe(true);
  });

  it("auto-migrates a degraded plaintext copy on the first successful Keychain write", async () => {
    const storage = memoryStorage();
    saveEnvToken(storage, "e1", "lgm_degraded");
    const { store, peek } = fakeSecretStore();

    const state = await loadEnvTokenSecure(store, storage, "e1");

    expect(state).toEqual({ token: "lgm_degraded", degraded: false });
    expect(peek(envTokenKey("e1"))).toBe("lgm_degraded");
    expect(loadEnvToken(storage, "e1")).toBe("");
  });

  it("clearing the token removes it from both stores", async () => {
    const storage = memoryStorage();
    const { store, peek } = fakeSecretStore();
    await saveEnvTokenSecure(store, storage, "e1", "lgm_keep");

    const result = await saveEnvTokenSecure(store, storage, "e1", "");

    expect(result).toEqual({ degraded: false });
    expect(peek(envTokenKey("e1"))).toBeNull();
    expect(loadEnvToken(storage, "e1")).toBe("");
  });

  it("deleteEnvTokenEverywhere clears Keychain slot and degraded plaintext at once (multi-env 04)", async () => {
    const storage = memoryStorage();
    const { store, peek } = fakeSecretStore();
    await store.set(envTokenKey("e1"), "lgm_secure");
    saveEnvToken(storage, "e2", "lgm_degraded"); // 降级副本场景

    await deleteEnvTokenEverywhere(store, storage, "e1");
    await deleteEnvTokenEverywhere(store, storage, "e2");

    expect(peek(envTokenKey("e1"))).toBeNull();
    expect(peek(envTokenKey("e2"))).toBeNull();
    expect(loadEnvToken(storage, "e1")).toBe("");
    expect(loadEnvToken(storage, "e2")).toBe("");
    // 全量清除（dev-stage 断言）：分槽表整体为空。
    expect(storage.getItem("lutragate.env-tokens")).toBe("{}");
  });

  it("deleteEnvTokenEverywhere with no secret store (web) clears only the plaintext slot", async () => {
    const storage = memoryStorage();
    saveEnvToken(storage, "e1", "lgm_web");

    await deleteEnvTokenEverywhere(null, storage, "e1");

    expect(loadEnvToken(storage, "e1")).toBe("");
  });
});

describe("normalizeBaseUrl", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(normalizeBaseUrl("  http://x.test/  ")).toBe("http://x.test");
    expect(normalizeBaseUrl("http://x.test///")).toBe("http://x.test");
    expect(normalizeBaseUrl("http://x.test/v1/")).toBe("http://x.test/v1");
  });
});

describe("defaultGatewayUrl（builtin-web 03 同源预填）", () => {
  it("http/https origin → 原样返回（内置 server/worker 同源部署）", () => {
    expect(defaultGatewayUrl({ protocol: "http:", origin: "http://127.0.0.1:8787" } as Location)).toBe(
      "http://127.0.0.1:8787",
    );
    expect(defaultGatewayUrl({ protocol: "https:", origin: "https://gw.example.com" } as Location)).toBe(
      "https://gw.example.com",
    );
  });

  it("非 http(s)（桌面 tauri:/自定义协议、file:）→ 空串，不预填", () => {
    expect(defaultGatewayUrl({ protocol: "tauri:", origin: "http://tauri.localhost" } as Location)).toBe("");
    expect(defaultGatewayUrl({ protocol: "file:", origin: "null" } as Location)).toBe("");
  });
});
