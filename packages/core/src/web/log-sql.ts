import type { RequestLogEntry } from "@lutragate/shared";

/** Shared request_log SQL for the D1 and bun:sqlite sinks (spec §3.3). */

export const REQUEST_LOG_INSERT_SQL = `INSERT INTO request_log (id, request_id, ts, client_model, upstream_model, provider_id, key_id, user_id, access_key_id, prompt_tokens, completion_tokens, latency_ms, status, error_type, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const REQUEST_LOG_RETENTION_SQL = "DELETE FROM request_log WHERE ts < ?";

export function requestLogParams(entry: RequestLogEntry): unknown[] {
  return [
    entry.id, entry.request_id, entry.ts, entry.client_model,
    entry.upstream_model ?? null, entry.provider_id ?? null, entry.key_id ?? null,
    entry.user_id ?? null, entry.access_key_id ?? null,
    entry.prompt_tokens ?? null, entry.completion_tokens ?? null,
    entry.latency_ms ?? null, entry.status, entry.error_type ?? null,
    entry.error_message ?? null,
  ];
}
