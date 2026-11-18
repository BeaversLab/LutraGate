import { z } from "zod";
import { newId } from "@lutragate/core";
import { GatewayConfigSchema, type GatewayConfig, type ProviderKey } from "@lutragate/shared";
import type { Env } from "./env";

/**
 * Tracer-bullet config loading (ticket 04): a simplified JSON shape injected
 * via GATEWAY_CONFIG, mapped to the shared GatewayConfig. Keys are supplied
 * as plaintext `api_key` and stored base64-encoded in `encrypted_key` — a
 * TEMPORARY convention until ticket 05 adds AES-GCM encryption with an
 * ENCRYPTION_KEY secret.
 */

/** TEMPORARY (until ticket 05): encode a plaintext key for the schema. */
export function encodePlaintextKey(apiKey: string): string {
  return btoa(apiKey);
}

/** TEMPORARY (until ticket 05): recover the plaintext key at forward time. */
export function decodeKey(key: ProviderKey): string {
  return atob(key.encrypted_key);
}

const EnvProviderSchema = z.object({
  name: z.string().min(1),
  base_url: z.url(),
  weight: z.number().int().positive().default(1),
  enabled: z.boolean().default(true),
});

const EnvKeySchema = z.object({
  /** Provider referenced by name. */
  provider: z.string().min(1),
  api_key: z.string().min(4),
});

const EnvMappingSchema = z.object({
  client_model: z.string().min(1),
  provider: z.string().min(1),
  upstream_model: z.string().min(1),
  enabled: z.boolean().default(true),
});

const EnvConfigSchema = z.object({
  providers: z.array(EnvProviderSchema),
  keys: z.array(EnvKeySchema),
  mappings: z.array(EnvMappingSchema),
});

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

/** Empty config: valid but unusable — /v1/* answers 401 (no access keys). */
export const EMPTY_CONFIG: GatewayConfig = {
  providers: [], keys: [], mappings: [],
  users: [], access_keys: [], grants: [],
};

export function loadConfig(env: Env): GatewayConfig {
  const raw = env.GATEWAY_CONFIG;
  if (!raw) return EMPTY_CONFIG;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new GatewayConfigError("GATEWAY_CONFIG is not valid JSON");
  }

  const parsed = EnvConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new GatewayConfigError(`GATEWAY_CONFIG invalid: ${parsed.error.message}`);
  }

  const now = Date.now();
  const providers = parsed.data.providers.map((p) => ({
    id: newId(),
    name: p.name,
    endpoints: { openai: p.base_url },
    enabled: p.enabled,
    weight: p.weight,
    created_at: now,
    updated_at: now,
  }));
  const providerIdByName = new Map(providers.map((p) => [p.name, p.id]));

  const keys = parsed.data.keys.flatMap((k) => {
    const providerId = providerIdByName.get(k.provider);
    if (!providerId) return []; // key for unknown provider is dropped
    return [{
      id: newId(),
      provider_id: providerId,
      encrypted_key: encodePlaintextKey(k.api_key),
      key_hint: k.api_key.slice(-4),
      enabled: true,
      cooldown_until: 0,
      failure_count: 0,
      created_at: now,
      updated_at: now,
    }];
  });

  const mappings = parsed.data.mappings.flatMap((m) => {
    const providerId = providerIdByName.get(m.provider);
    if (!providerId) return [];
    return [{
      id: newId(),
      client_model: m.client_model,
      provider_id: providerId,
      upstream_model: m.upstream_model,
      enabled: m.enabled,
    }];
  });

  const config = GatewayConfigSchema.safeParse({ providers, keys, mappings });
  if (!config.success) {
    throw new GatewayConfigError(`GATEWAY_CONFIG invalid: ${config.error.message}`);
  }
  return config.data;
}
