import { describe, expect, it } from "vitest";
import { GatewayConfigError, loadConfig } from "./config";

const envConfig = {
  providers: [
    { name: "a", base_url: "https://a.test" },
    { name: "b", base_url: "https://b.test", weight: 2, enabled: false },
  ],
  keys: [
    { provider: "a", api_key: "sk-aaaa-key-a" },
    { provider: "b", api_key: "sk-bbbb-key-b" },
    { provider: "ghost", api_key: "sk-cccc-key-c" }, // unknown provider → dropped
  ],
  mappings: [
    { client_model: "m1", provider: "a", upstream_model: "a-up" },
    { client_model: "m1", provider: "b", upstream_model: "b-up" },
    { client_model: "m2", provider: "ghost", upstream_model: "x" }, // dropped
  ],
};

function load(raw?: string) {
  return loadConfig({ GATEWAY_CONFIG: raw ?? JSON.stringify(envConfig) });
}

describe("loadConfig", () => {
  it("maps the simplified env shape onto a valid GatewayConfig", () => {
    const config = load();
    expect(config.providers).toHaveLength(2);
    expect(config.keys).toHaveLength(2);
    expect(config.mappings).toHaveLength(2);

    const a = config.providers[0]!;
    expect(a.name).toBe("a");
    expect(a.weight).toBe(1);
    expect(config.providers[1]!.weight).toBe(2);
    expect(config.providers[1]!.enabled).toBe(false);

    const keyA = config.keys[0]!;
    expect(keyA.provider_id).toBe(a.id);
    expect(keyA.key_hint).toBe("ey-a"); // last 4 of api_key
    // TEMP convention: base64 of the plaintext key
    expect(atob(keyA.encrypted_key)).toBe("sk-aaaa-key-a");

    expect(config.mappings[0]!.upstream_model).toBe("a-up");
  });

  it("generates unique 21-char ids", () => {
    const config = load();
    const ids = [
      ...config.providers.map((p) => p.id),
      ...config.keys.map((k) => k.id),
      ...config.mappings.map((m) => m.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });

  it("returns EMPTY_CONFIG when GATEWAY_CONFIG is absent", () => {
    const config = loadConfig({});
    expect(config.providers).toHaveLength(0);
  });

  it("rejects invalid JSON", () => {
    expect(() => load("{nope")).toThrow(GatewayConfigError);
  });

  it("rejects structurally invalid config", () => {
    expect(() => load(JSON.stringify({ providers: [{ name: "" }], keys: [], mappings: [] }))).toThrow(
      GatewayConfigError,
    );
  });
});
