import { describe, expect, it } from "vitest";
import {
  AdminAuditSchema,
  ConfigAccessKeySchema,
  GatewayConfigSchema,
  ManagementTokenSchema,
  ModelMappingSchema,
  ProviderKeySchema,
  ProviderSchema,
  RequestLogEntrySchema,
} from "./schemas";
import { ERROR_CODES, ErrorBodySchema, errorBody } from "./errors";

// Valid 21-char nanoids.
const ID = "V1StGXR8_Z5jdHi6B-myT";
const ID2 = "V1StGXR8_Z5jdHi6B-myU";

const provider = {
  id: ID,
  name: "openai",
  endpoints: { openai: "https://api.openai.com" },
  enabled: true,
  weight: 3,
  created_at: 1731024000000,
  updated_at: 1731024000000,
};

const providerKey = {
  id: ID2,
  provider_id: ID,
  // base64 of 12B iv + ciphertext + 16B tag
  encrypted_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  key_hint: "sk-9",
  enabled: true,
  cooldown_until: 0,
  failure_count: 0,
  created_at: 1731024000000,
  updated_at: 1731024000000,
};

const mapping = {
  id: ID2,
  client_model: "gpt-4o",
  provider_id: ID,
  upstream_model: "gpt-4o-2024-11-20",
  enabled: true,
};

const logEntry = {
  id: ID,
  request_id: "req-1",
  ts: 1731024000000,
  client_model: "gpt-4o",
  upstream_model: "gpt-4o-2024-11-20",
  provider_id: ID,
  key_id: ID2,
  prompt_tokens: 100,
  completion_tokens: 42,
  latency_ms: 850,
  status: 200,
};

const audit = {
  id: ID,
  ts: 1731024000000,
  action: "provider.create",
  target: ID,
  detail: "created openai",
};

/** JSON round-trip: parse → stringify → parse must be lossless. */
function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown) {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return first;
}

describe("ProviderSchema", () => {
  it("round-trips a full row", () => {
    roundTrip(ProviderSchema, provider);
  });

  it("applies defaults for enabled/weight", () => {
    const parsed = ProviderSchema.parse({
      ...provider,
      enabled: undefined,
      weight: undefined,
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.weight).toBe(1);
  });

  it("applies zero defaults for cooldown overrides (access-control)", () => {
    const parsed = ProviderSchema.parse(provider);
    expect(parsed.cooldown_failure_threshold).toBe(0);
    expect(parsed.cooldown_ms).toBe(0);
    roundTrip(ProviderSchema, { ...provider, cooldown_failure_threshold: 5, cooldown_ms: 120_000 });
  });

  it.each([
    ["bad id", { ...provider, id: "not-a-nanoid" }],
    ["bad url", { ...provider, endpoints: { openai: "not-a-url" } }],
    ["no endpoints at all", { ...provider, endpoints: {} }],
    ["negative ts", { ...provider, created_at: -1 }],
    ["zero weight", { ...provider, weight: 0 }],
    ["fractional weight", { ...provider, weight: 1.5 }],
  ])("rejects %s", (_name, value) => {
    expect(ProviderSchema.safeParse(value).success).toBe(false);
  });
});

describe("ProviderKeySchema", () => {
  it("round-trips a full row", () => {
    roundTrip(ProviderKeySchema, providerKey);
  });

  it.each([
    ["non-base64 ciphertext", { ...providerKey, encrypted_key: "not base64!" }],
    ["wrong provider id", { ...providerKey, provider_id: "short" }],
    ["hint not 4 chars", { ...providerKey, key_hint: "sk-99" }],
    ["negative failure_count", { ...providerKey, failure_count: -1 }],
  ])("rejects %s", (_name, value) => {
    expect(ProviderKeySchema.safeParse(value).success).toBe(false);
  });
});

describe("ModelAccessControlSchemas (access-control)", () => {
  it("ManagementTokenSchema defaults expires_at/last_used_at to 0", () => {
    const parsed = {
      id: ID,
      user_id: ID2,
      token_hash: "a".repeat(64),
      key_hint: "lgm_".slice(-4),
      enabled: true,
      created_at: 1731024000000,
      updated_at: 1731024000000,
    };
    const token = ManagementTokenSchema.parse(parsed);
    expect(token.expires_at).toBe(0);
    expect(token.last_used_at).toBe(0);
    expect(
      ManagementTokenSchema.safeParse({ ...parsed, expires_at: -1 }).success,
    ).toBe(false);
  });

  it("ConfigAccessKeySchema carries expires_at/ip_allowlist with defaults", () => {
    const base = {
      id: ID,
      user_id: ID2,
      key_hash: "b".repeat(64),
      enabled: true,
    };
    expect(ConfigAccessKeySchema.parse(base)).toMatchObject({ expires_at: 0, ip_allowlist: [] });
    expect(
      ConfigAccessKeySchema.parse({ ...base, expires_at: 1731024000000, ip_allowlist: ["10.0.0.0/8"] }),
    ).toMatchObject({ expires_at: 1731024000000, ip_allowlist: ["10.0.0.0/8"] });
  });
});

describe("ModelMappingSchema", () => {
  it("round-trips", () => {
    roundTrip(ModelMappingSchema, mapping);
  });

  it("rejects empty model names", () => {
    expect(
      ModelMappingSchema.safeParse({ ...mapping, upstream_model: "" }).success,
    ).toBe(false);
  });
});

describe("RequestLogEntrySchema", () => {
  it("round-trips with optional fields present", () => {
    roundTrip(RequestLogEntrySchema, logEntry);
  });

  it("accepts a minimal failure entry", () => {
    const parsed = roundTrip(RequestLogEntrySchema, {
      id: ID,
      request_id: "req-2",
      ts: 1731024000000,
      client_model: "gpt-4o",
      status: 0,
      error_type: "NETWORK",
    });
    expect(parsed.provider_id).toBeUndefined();
    expect(parsed.latency_ms).toBeUndefined();
  });

  it("rejects non-integer status", () => {
    expect(
      RequestLogEntrySchema.safeParse({ ...logEntry, status: 200.5 }).success,
    ).toBe(false);
  });
});

describe("AdminAuditSchema", () => {
  it("round-trips with optional fields", () => {
    roundTrip(AdminAuditSchema, audit);
  });

  it("accepts minimal entry without target/detail", () => {
    const parsed = AdminAuditSchema.parse({
      id: ID,
      ts: 1731024000000,
      action: "config.reload",
    });
    expect(parsed.target).toBeUndefined();
    expect(parsed.detail).toBeUndefined();
  });
});

describe("GatewayConfigSchema", () => {
  it("round-trips the aggregate", () => {
    const config = roundTrip(GatewayConfigSchema, {
      providers: [provider],
      keys: [providerKey],
      mappings: [mapping],
    });
    expect(config.providers).toHaveLength(1);
    expect(config.keys[0]?.provider_id).toBe(provider.id);
  });

  it("rejects a key whose provider_id is not a valid id", () => {
    expect(
      GatewayConfigSchema.safeParse({
        providers: [provider],
        keys: [{ ...providerKey, provider_id: "oops" }],
        mappings: [],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate (client_model, provider_id) mappings", () => {
    expect(
      GatewayConfigSchema.safeParse({
        providers: [provider],
        keys: [],
        mappings: [mapping, { ...mapping, id: ID }],
      }).success,
    ).toBe(false);
  });
});

describe("errors", () => {
  it("every code produces a valid ErrorBody", () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(ErrorBodySchema.safeParse(errorBody(code, "x")).success).toBe(
        true,
      );
    }
  });

  it("errorBody produces a valid ErrorBody", () => {
    const body = errorBody(ERROR_CODES.NO_CHANNEL, "no channel available");
    expect(ErrorBodySchema.parse(body)).toEqual(body);
    expect(body.error.code).toBe("NO_CHANNEL");
  });

  it("ErrorBodySchema rejects unknown codes", () => {
    expect(
      ErrorBodySchema.safeParse({
        error: { code: "SOMETHING_ELSE", message: "x" },
      }).success,
    ).toBe(false);
  });
});
