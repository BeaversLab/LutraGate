import { z } from "zod";

/**
 * Machine-readable error codes, centralized in shared (spec §3.6).
 * Upstream 4xx bodies are passed through verbatim and never re-wrapped.
 */
export const ERROR_CODES = {
  /** No usable channel: no mapping / all providers or keys disabled / all cooling down. */
  NO_CHANNEL: "NO_CHANNEL",
  /** Client model has no mapping in config. */
  INVALID_MODEL: "INVALID_MODEL",
  /** Missing or invalid gateway/admin credentials. */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** All retries exhausted or upstream unreachable. */
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  /** Local concurrency/rate limit tripped before forwarding. */
  RATE_LIMITED_LOCAL: "RATE_LIMITED_LOCAL",
  /** Malformed request body or query. */
  BAD_REQUEST: "BAD_REQUEST",
  /** HTTP method not allowed for the route. */
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  /** Resource does not exist. */
  NOT_FOUND: "NOT_FOUND",
  /** Authenticated but not allowed. */
  FORBIDDEN: "FORBIDDEN",
  /** Client IP outside the access key's CIDR allowlist (access-control). */
  IP_NOT_ALLOWED: "IP_NOT_ALLOWED",
  /** Resource conflict, e.g. duplicate mapping. */
  CONFLICT: "CONFLICT",
  /** Provider type has no usage adapter (provider-usage); UI hides the usage cell. */
  USAGE_UNSUPPORTED: "USAGE_UNSUPPORTED",
  /** Provider lacks management credentials for usage query (provider-usage); UI shows a setup hint. */
  USAGE_NO_CREDENTIALS: "USAGE_NO_CREDENTIALS",
  /** Unexpected internal failure. */
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Unified error body for all non-proxy endpoints (spec §3.6). */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
  }),
});
export type ErrorBody = z.output<typeof ErrorBodySchema>;

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}
