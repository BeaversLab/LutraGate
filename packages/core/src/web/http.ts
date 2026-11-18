import { errorBody, ERROR_CODES } from "@lutragate/shared";

/** Unified JSON error response (spec §3.6). */
export function jsonError(status: number, code: keyof typeof ERROR_CODES, message: string): Response {
  return new Response(JSON.stringify(errorBody(ERROR_CODES[code], message)), {
    status,
    headers: { "content-type": "application/json" },
  });
}
