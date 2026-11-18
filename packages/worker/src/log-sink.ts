import { REQUEST_LOG_INSERT_SQL, REQUEST_LOG_RETENTION_SQL, requestLogParams } from "@lutragate/core";
import type { LogSink } from "@lutragate/core";
import type { RequestLogEntry } from "@lutragate/shared";

/**
 * D1-backed LogSink (ticket 08): fire-and-forget inserts into request_log
 * plus a best-effort retention cleanup (default 14 days, spec §3.3). The
 * returned promise never rejects — failures are logged via console.warn so
 * the proxied request is never affected. Returns a Promise so adapters can
 * pass it to ctx.waitUntil.
 */

export const LOG_RETENTION_DAYS = 14;
const DAY_MS = 86_400_000;

export interface D1LogSinkOptions {
  now?: () => number;
}

export class D1LogSink implements LogSink {
  constructor(
    private readonly db: D1Database,
    private readonly options: D1LogSinkOptions = {},
  ) {}

  write(entry: RequestLogEntry): Promise<void> {
    const now = this.options.now ?? Date.now;
    const cutoff = now() - LOG_RETENTION_DAYS * DAY_MS;
    return Promise.all([
      this.db
        .prepare(REQUEST_LOG_INSERT_SQL)
        .bind(...requestLogParams(entry))
        .run(),
      // Best-effort retention cleanup (spec §3.3).
      this.db.prepare(REQUEST_LOG_RETENTION_SQL).bind(cutoff).run(),
    ])
      .then(() => undefined)
      .catch((err) => {
        console.warn("request log write failed silently:", err);
      });
  }
}
