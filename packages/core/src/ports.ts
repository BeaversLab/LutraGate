/**
 * Port interfaces defined by core, implemented by adapters (spec §3.1).
 * core itself must not import any runtime-specific API.
 */

/** Injectable clock for deterministic tests. */
export interface Clock {
  now(): number;
}

/** Injectable random source in [0, 1) for deterministic tests. */
export type Rng = () => number;

/**
 * Injectable HTTP client (spec §3.1). Uses web-standard Request/Response so
 * the same port works on Workers, Bun and Node.
 */
export interface Fetcher {
  fetch(req: Request): Promise<Response>;
}

/** Read access to the active gateway configuration (spec §3.1). */
export interface ConfigStore {
  getActiveConfig(): Promise<import("@lutragate/shared").GatewayConfig>;
}

/**
 * Fire-and-forget request logging (spec §3.1): implementations must never
 * throw into the request path; failures are swallowed. May return a promise
 * so adapters can track it via waitUntil.
 */
export interface LogSink {
  write(entry: import("@lutragate/shared").RequestLogEntry): void | Promise<void>;
}
