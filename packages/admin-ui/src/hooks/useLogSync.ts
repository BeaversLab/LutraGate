import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminApi } from "../lib/api";
import { syncLogsOnce, type SyncResult } from "../lib/sync";
import type { LogStore } from "../lib/logstore";

export interface SyncState {
  busy: boolean;
  lastSyncAt: number | null;
  lastResult: SyncResult | null;
  error: string | null;
}

/** 同步完成后派发的全局事件（UI 2.0 #11）：页脚同步状态条监听刷新，
 * 避免对 Dexie 连接做周期性轮询（轮询会与删库竞态、复活空 schema 库）。 */
export const LOG_SYNC_EVENT = "lutragate:log-synced";

/** 定时（默认 5 分钟）+ 手动触发的日志增量同步。 */
export function useLogSync(api: AdminApi, db: LogStore, intervalMs = 5 * 60_000): SyncState & { syncNow: () => void } {
  const [state, setState] = useState<SyncState>({
    busy: false,
    lastSyncAt: null,
    lastResult: null,
    error: null,
  });
  const running = useRef(false);
  const generation = useRef(0);

  const syncNow = useCallback(async () => {
    if (running.current) return;
    const currentGeneration = generation.current;
    running.current = true;
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const result = await syncLogsOnce(api, db);
      if (generation.current !== currentGeneration) return;
      setState({ busy: false, lastSyncAt: Date.now(), lastResult: result, error: null });
      window.dispatchEvent(new CustomEvent(LOG_SYNC_EVENT));
    } catch (err) {
      if (generation.current !== currentGeneration) return;
      setState((s) => ({
        ...s,
        busy: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      if (generation.current === currentGeneration) running.current = false;
    }
  }, [api, db]);

  useEffect(() => {
    void syncNow(); // 挂载即同步一次
    const timer = setInterval(() => void syncNow(), intervalMs);
    return () => { clearInterval(timer); generation.current += 1; running.current = false; };
  }, [syncNow, intervalMs]);

  return { ...state, syncNow: () => void syncNow() };
}
