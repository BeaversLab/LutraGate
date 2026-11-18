import { describe, expect, it } from "vitest";
import type { GatewayConfig, ModelMapping, Provider, ProviderKey } from "@lutragate/shared";
import { NoChannelError, selectChannel } from "./select-channel";

const NOW = 1_000_000;

// Distinct 21-char nanoids.
const PID_A = "V1StGXR8_Z5jdHi6B-myA";
const PID_B = "V1StGXR8_Z5jdHi6B-myB";
const KID_A1 = "V1StGXR8_Z5jdHi6B-myC";
const KID_A2 = "V1StGXR8_Z5jdHi6B-myD";
const KID_B1 = "V1StGXR8_Z5jdHi6B-myE";

const T0 = 1_731_024_000_000;

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: PID_A,
    name: "provider-a",
    type: "custom",
    endpoints: { openai: "https://a.example.com" },
    enabled: true,
    weight: 1,
    cooldown_failure_threshold: 0,
    cooldown_ms: 0,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

function key(overrides: Partial<ProviderKey> = {}): ProviderKey {
  return {
    id: KID_A1,
    provider_id: PID_A,
    encrypted_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    key_hint: "sk-1",
    enabled: true,
    cooldown_until: 0,
    failure_count: 0,
    daily_token_limit: 0,
    daily_request_limit: 0,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

function mapping(overrides: Partial<ModelMapping> = {}): ModelMapping {
  return {
    id: "V1StGXR8_Z5jdHi6B-myF",
    client_model: "gpt-4o",
    provider_id: PID_A,
    upstream_model: "gpt-4o-2024-11-20",
    enabled: true,
    ...overrides,
  };
}

const defaultOpts = { clock: { now: () => NOW } };

function buildConfig(parts: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    providers: [provider()],
    keys: [key()],
    mappings: [mapping()],
    // 多用户快照字段不参与通道选择，统一给空集。
    users: [],
    access_keys: [],
    grants: [],
    ...parts,
  };
}

/** Two providers both mapping "gpt-4o", weights overridable. */
function twoProviderConfig(
  weightA = 1,
  weightB = 1,
): GatewayConfig {
  return {
    providers: [
      provider({ weight: weightA }),
      provider({ id: PID_B, name: "provider-b", endpoints: { openai: "https://b.example.com" }, weight: weightB }),
    ],
    keys: [key(), key({ id: KID_B1, provider_id: PID_B })],
    mappings: [mapping(), mapping({ provider_id: PID_B })],
    users: [],
    access_keys: [],
    grants: [],
  };
}

function pickProviders(
  config: GatewayConfig,
  runs = 200,
  cooldowns: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < runs; i++) {
    const { provider } = selectChannel(config, "gpt-4o", cooldowns, defaultOpts);
    counts.set(provider.id, (counts.get(provider.id) ?? 0) + 1);
  }
  return counts;
}

function reasonFor(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(NoChannelError);
    return (err as NoChannelError).reason;
  }
  throw new Error("expected NoChannelError");
}

describe("selectChannel: mapping resolution", () => {
  it("resolves client_model to (provider, key, upstream_model)", () => {
    const channel = selectChannel(buildConfig(), "gpt-4o", new Map(), defaultOpts);
    expect(channel.provider.id).toBe(PID_A);
    expect(channel.key.id).toBe(KID_A1);
    expect(channel.upstream_model).toBe("gpt-4o-2024-11-20");
  });

  it("aggregates duplicate client_model mappings across providers as fallbacks", () => {
    const seen = pickProviders(twoProviderConfig(), 100);
    expect(seen.get(PID_A)).toBeGreaterThan(0);
    expect(seen.get(PID_B)).toBeGreaterThan(0);
  });

  it("treats a disabled mapping as ALL_DISABLED (not NO_MAPPING)", () => {
    const config = buildConfig({ mappings: [mapping({ enabled: false })] });
    expect(reasonFor(() => selectChannel(config, "gpt-4o", new Map(), defaultOpts))).toBe("ALL_DISABLED");
  });
});

describe("selectChannel: filtering", () => {
  it("skips disabled providers", () => {
    const config = buildConfig({ providers: [provider({ enabled: false })] });
    expect(() => selectChannel(config, "gpt-4o", new Map(), defaultOpts)).toThrow(NoChannelError);
  });

  it("skips disabled keys", () => {
    const config = buildConfig({ keys: [key({ enabled: false })] });
    expect(() => selectChannel(config, "gpt-4o", new Map(), defaultOpts)).toThrow(NoChannelError);
  });

  it("skips keys whose runtime cooldown has not expired", () => {
    const cooldowns = new Map([[KID_A1, NOW + 60_000]]);
    expect(() => selectChannel(buildConfig(), "gpt-4o", cooldowns, defaultOpts)).toThrow(NoChannelError);
  });

  it("lazily recovers keys whose cooldown expired (cooldown_until < now)", () => {
    const cooldowns = new Map([[KID_A1, NOW - 1]]);
    const channel = selectChannel(buildConfig(), "gpt-4o", cooldowns, defaultOpts);
    expect(channel.key.id).toBe(KID_A1);
  });

  it("treats a key cooling down as unavailable while a sibling key stays usable", () => {
    const config = buildConfig({ keys: [key(), key({ id: KID_A2 })] });
    const cooldowns = new Map([[KID_A1, NOW + 60_000]]);
    const picked = new Set<string>();
    for (let i = 0; i < 20; i++) {
      picked.add(selectChannel(config, "gpt-4o", cooldowns, defaultOpts).key.id);
    }
    expect(picked).toEqual(new Set([KID_A2]));
  });

  it("ignores persisted cooldown_until (runtime map is authoritative)", () => {
    const config = buildConfig({ keys: [key({ cooldown_until: NOW + 60_000 })] });
    const channel = selectChannel(config, "gpt-4o", new Map(), defaultOpts);
    expect(channel.key.id).toBe(KID_A1);
  });
});

describe("selectChannel: weighted random", () => {
  it("distributes provider picks by weight (statistical)", () => {
    const runs = 20_000;
    const counts = pickProviders(twoProviderConfig(3, 1), runs);
    const shareA = (counts.get(PID_A) ?? 0) / runs;
    // Expect ~0.75; binomial se at n=20000 is ~0.0031, so ±0.02 is >6σ.
    expect(shareA).toBeGreaterThan(0.73);
    expect(shareA).toBeLessThan(0.77);
  });

  it("selects keys uniformly within a provider (statistical)", () => {
    const config = buildConfig({ keys: [key(), key({ id: KID_A2 })] });
    const runs = 20_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < runs; i++) {
      const { key: picked } = selectChannel(config, "gpt-4o", new Map(), defaultOpts);
      counts.set(picked.id, (counts.get(picked.id) ?? 0) + 1);
    }
    const share1 = (counts.get(KID_A1) ?? 0) / runs;
    // Expect ~0.5; ±0.02 is >6σ at n=20000.
    expect(share1).toBeGreaterThan(0.48);
    expect(share1).toBeLessThan(0.52);
  });

  it("is deterministic under an injected rng", () => {
    const config = twoProviderConfig();
    // rng < 0.5 → first provider (A); rng >= 0.5 → second (B); then key pick 0 → first key.
    const channelA = selectChannel(config, "gpt-4o", new Map(), { ...defaultOpts, rng: () => 0.25 });
    expect(channelA.provider.id).toBe(PID_A);
    expect(channelA.key.id).toBe(KID_A1);
    const channelB = selectChannel(config, "gpt-4o", new Map(), { ...defaultOpts, rng: () => 0.75 });
    expect(channelB.provider.id).toBe(PID_B);
    expect(channelB.key.id).toBe(KID_B1);
  });
});

describe("selectChannel: NO_CHANNEL reasons", () => {
  it("NO_MAPPING when client_model has no mapping at all", () => {
    expect(reasonFor(() => selectChannel(buildConfig(), "unknown-model", new Map(), defaultOpts))).toBe("NO_MAPPING");
  });

  it("ALL_DISABLED when mappings exist but providers/keys are disabled", () => {
    const config = buildConfig({ providers: [provider({ enabled: false })] });
    expect(reasonFor(() => selectChannel(config, "gpt-4o", new Map(), defaultOpts))).toBe("ALL_DISABLED");
  });

  it("ALL_DISABLED when all keys are disabled", () => {
    const config = buildConfig({ keys: [key({ enabled: false })] });
    expect(reasonFor(() => selectChannel(config, "gpt-4o", new Map(), defaultOpts))).toBe("ALL_DISABLED");
  });

  it("ALL_COOLDOWN when providers/keys are enabled but every key is cooling down", () => {
    const cooldowns = new Map([
      [KID_A1, NOW + 60_000],
      [KID_B1, NOW + 60_000],
    ]);
    expect(reasonFor(() => selectChannel(twoProviderConfig(), "gpt-4o", cooldowns, defaultOpts))).toBe("ALL_COOLDOWN");
  });

  it("ALL_DISABLED when a mapping points at a missing provider", () => {
    const config = buildConfig({
      providers: [],
      mappings: [mapping()],
    });
    expect(reasonFor(() => selectChannel(config, "gpt-4o", new Map(), defaultOpts))).toBe("ALL_DISABLED");
  });

  it("error carries NO_CHANNEL code and a human-readable message", () => {
    try {
      selectChannel(buildConfig(), "unknown-model", new Map(), defaultOpts);
      throw new Error("expected NoChannelError");
    } catch (err) {
      const e = err as NoChannelError;
      expect(e.code).toBe("NO_CHANNEL");
      expect(e.message).toContain("unknown-model");
    }
  });
});
