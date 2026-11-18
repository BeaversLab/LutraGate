import { ERROR_CODES, errorBody } from "@lutragate/shared";
import type { GatewayConfig, Provider } from "@lutragate/shared";
import type { Clock, Fetcher, Rng } from "./ports";
import type { CooldownOverride, KeyState } from "./key-state";
import { selectChannel, type SelectedChannel } from "./select-channel";

/**
 * Retry orchestration for a single proxied upstream call (spec §3.2).
 * Retryable: 5xx, 429, network errors, timeouts. Non-429 4xx responses are
 * passed through untouched (no retry, no failure counting).
 */

export const RETRIES_DEFAULT = 2;
export const TIMEOUT_MS_DEFAULT = 120_000;

export interface ExecuteWithRetryArgs {
  config: GatewayConfig;
  clientModel: string;
  /**
   * Builds the upstream request for a selected channel (URL/model/auth).
   * May be async — e.g. to decrypt the provider key at forward time.
   */
  buildRequest: (channel: SelectedChannel) => Request | Promise<Request>;
  fetcher: Fetcher;
  /** Caller-owned failure/cooldown state, persisted across requests. */
  keyState: KeyState;
  /** Max retries after the first attempt; default 2. */
  retries?: number;
  /** Per-attempt upstream timeout in ms; default 120s. */
  timeoutMs?: number;
  clock?: Clock;
  rng?: Rng;
}

/**
 * Resolves to the upstream Response on success or non-429 4xx (verbatim), or
 * to a 502 UPSTREAM_ERROR Response when all attempts are exhausted. Throws
 * NoChannelError when no channel is selectable.
 */
export async function executeWithRetry(args: ExecuteWithRetryArgs): Promise<Response> {
  const {
    config,
    clientModel,
    buildRequest,
    fetcher,
    keyState,
    retries = RETRIES_DEFAULT,
    timeoutMs = TIMEOUT_MS_DEFAULT,
    clock,
    rng,
  } = args;

  const attempts = retries + 1;
  const effClock = clock ?? systemClock;
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Fresh channel each round: keys that cooled down mid-retry are skipped.
    const channel = selectChannel(config, clientModel, keyState.cooldowns, { clock: effClock, rng });
    const request = await buildRequest(channel);
    const providerLabel = channel.provider.name;

    let response: Response;
    try {
      response = await fetchWithTimeout(fetcher, request, timeoutMs);
    } catch (err) {
      // A well-behaved fetcher may surface the abort as AbortError before
      // the TimeoutMarker wins the race; classify both as timeouts.
      if (err instanceof TimeoutMarker || (err instanceof Error && err.name === "AbortError")) {
        lastError = `${providerLabel} timed out after ${timeoutMs}ms`;
      } else {
        lastError = `${providerLabel} network error: ${err instanceof Error ? err.message : String(err)}`;
      }
      keyState.recordFailure(channel.key.id, effClock.now(), cooldownOverride(channel.provider));
      continue;
    }

    if (response.ok) {
      return response;
    }

    const status = response.status;
    if (status === 429 || status >= 500) {
      lastError = `${providerLabel} HTTP ${status}`;
      keyState.recordFailure(channel.key.id, effClock.now(), cooldownOverride(channel.provider));
      continue;
    }

    // Non-retryable status (non-429 4xx, 3xx): pass the upstream response
    // through untouched — no retry, no failure counting.
    return response;
  }

  return new Response(JSON.stringify(errorBody(ERROR_CODES.UPSTREAM_ERROR, `all ${attempts} attempts failed; last error: ${lastError}`)), {
    status: 502,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Provider 级冷却覆盖（access-control 02）：从 channel 所属 provider 解析，
 * 0/缺省字段 → undefined（回落实例全局默认 3 次/60s）。
 */
function cooldownOverride(provider: Provider): CooldownOverride | undefined {
  const threshold = provider.cooldown_failure_threshold > 0 ? provider.cooldown_failure_threshold : undefined;
  const cooldownMs = provider.cooldown_ms > 0 ? provider.cooldown_ms : undefined;
  return threshold !== undefined || cooldownMs !== undefined ? { threshold, cooldownMs } : undefined;
}

/** Internal marker distinguishing timeouts from other fetch errors. */
class TimeoutMarker extends Error {}

const systemClock: Clock = { now: () => Date.now() };

/**
 * Race the fetch against a timeout; the request's AbortSignal is aborted on
 * timeout so well-behaved fetchers cancel, while the race guarantees the
 * classifier runs even if a fetcher ignores the signal.
 */
function fetchWithTimeout(fetcher: Fetcher, request: Request, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new TimeoutMarker()), { once: true });
  });
  return Promise.race([
    fetcher.fetch(withSignal(request, controller.signal)),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

/** Returns a Request carrying the given abort signal. */
function withSignal(request: Request, signal: AbortSignal): Request {
  return new Request(request, { signal });
}
