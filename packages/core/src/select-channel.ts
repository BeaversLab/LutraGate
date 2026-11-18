import { ERROR_CODES } from "@lutragate/shared";
import type { GatewayConfig, Provider, ProviderKey } from "@lutragate/shared";
import type { Clock, Rng } from "./ports";

/**
 * Channel selection (spec §3.2): resolve client_model → candidate
 * (provider, key, upstream_model), filter disabled providers/keys and keys in
 * cooldown, then pick a provider weighted by provider.weight and a key
 * uniformly at random within that provider.
 */

/** Runtime cooldown table: key_id → cooldown_until (epoch ms). */
export type Cooldowns = ReadonlyMap<string, number>;

export type NoChannelReason =
  /** No mapping exists for the client model. */
  | "NO_MAPPING"
  /** Mappings exist but no provider/key is enabled. */
  | "ALL_DISABLED"
  /** Providers and keys are enabled but every key is cooling down. */
  | "ALL_COOLDOWN";

export class NoChannelError extends Error {
  readonly code = ERROR_CODES.NO_CHANNEL;

  constructor(
    readonly reason: NoChannelReason,
    message: string,
  ) {
    super(message);
    this.name = "NoChannelError";
  }
}

export interface SelectedChannel {
  provider: Provider;
  key: ProviderKey;
  upstream_model: string;
}

export interface SelectChannelOptions {
  /** Injectable clock; defaults to Date.now. */
  clock?: Clock;
  /** Injectable random source in [0, 1); defaults to Math.random. */
  rng?: Rng;
}

/**
 * Throws NoChannelError (code NO_CHANNEL) when no channel is usable.
 */
export function selectChannel(
  config: GatewayConfig,
  clientModel: string,
  cooldowns: Cooldowns,
  options: SelectChannelOptions = {},
): SelectedChannel {
  const now = (options.clock ?? { now: () => Date.now() }).now();
  const rng = options.rng ?? Math.random;

  // 1. Resolve candidate mappings for the client model (enabled checked in
  //    step 2 so a disabled mapping classifies as ALL_DISABLED, not NO_MAPPING).
  const mappings = config.mappings.filter((m) => m.client_model === clientModel);
  if (mappings.length === 0) {
    throw new NoChannelError(
      "NO_MAPPING",
      `no model mapping for client model "${clientModel}"`,
    );
  }

  // 2. Collect enabled providers with their enabled keys (per provider, a
  //    mapping is unique per (client_model, provider_id)).
  const providerById = new Map(config.providers.map((p) => [p.id, p]));
  const keysByProvider = new Map<string, ProviderKey[]>();
  for (const k of config.keys) {
    if (!k.enabled) continue;
    const list = keysByProvider.get(k.provider_id);
    if (list) list.push(k);
    else keysByProvider.set(k.provider_id, [k]);
  }

  const candidates: Array<{ provider: Provider; keys: ProviderKey[]; upstream_model: string }> = [];
  for (const m of mappings) {
    if (!m.enabled) continue;
    const provider = providerById.get(m.provider_id);
    if (!provider || !provider.enabled) continue;
    const keys = keysByProvider.get(m.provider_id);
    if (!keys || keys.length === 0) continue;
    candidates.push({ provider, keys, upstream_model: m.upstream_model });
  }

  // 3. Empty set → structured error with the specific cause.
  if (candidates.length === 0) {
    throw new NoChannelError(
      "ALL_DISABLED",
      `all channels for client model "${clientModel}" are disabled`,
    );
  }

  // 4. Lazy cooldown check: cooldown_until < now counts as recovered. The
  //    persisted key.cooldown_until is display-only (spec §3.3); the runtime
  //    table is authoritative.
  const available = candidates
    .map((c) => ({
      ...c,
      keys: c.keys.filter((k) => {
        const until = cooldowns.get(k.id);
        return until === undefined || until < now;
      }),
    }))
    .filter((c) => c.keys.length > 0);

  if (available.length === 0) {
    throw new NoChannelError(
      "ALL_COOLDOWN",
      `all keys for client model "${clientModel}" are in cooldown`,
    );
  }

  // 5. Weighted random provider pick, uniform random key pick. Precondition:
  //    ProviderSchema enforces weight as a positive integer, so totalWeight > 0.
  const totalWeight = available.reduce((sum, c) => sum + c.provider.weight, 0);
  let roll = rng() * totalWeight;
  let chosen = available[0] as (typeof available)[number];
  for (const c of available) {
    roll -= c.provider.weight;
    if (roll < 0) {
      chosen = c;
      break;
    }
  }

  const key = chosen.keys[Math.floor(rng() * chosen.keys.length)] as ProviderKey;
  return { provider: chosen.provider, key, upstream_model: chosen.upstream_model };
}
