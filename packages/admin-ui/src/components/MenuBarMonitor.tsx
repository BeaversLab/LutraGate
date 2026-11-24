import { useCallback, useEffect, useMemo, useRef } from "react";
import { ApiError, type AdminApi, type Identity } from "../lib/api";
import {
  alertCount,
  alertTitle,
  loadMenuBarData,
  loadStoredScope,
  MENU_BAR_SCOPE_KEY,
  MENU_TICK_EVENT,
  resolveScope,
} from "../lib/menu-bar";
import { detectTauriInternals, safeInvoke } from "../lib/tauri";

/**
 * 菜单栏后台监视（menu-bar-usage 06）：主窗口隐藏后仍是活着的 Webview。
 * Rust 壳每 60s 派发 MENU_TICK_EVENT（面板可见时让位，由面板自行刷新）；
 * 这里按当前持久化视角拉当日数据，用纯函数算告警数，经命令设置托盘标题。
 * 401 = 停止轮询并清空标题（换新凭证重建 api 后恢复）；网络失败保留上次标题。
 */
export function MenuBarMonitor({ api, identity }: { api: AdminApi | null; identity: Identity | null }) {
  const internals = useMemo(() => detectTauriInternals(), []);
  const stopped = useRef(false);
  const busy = useRef(false);
  /** 身份/环境代数：切换后丢弃在途的旧响应，避免标题按旧视角落地。 */
  const generation = useRef(0);

  const setTitle = useCallback((title: string | null) => {
    safeInvoke("set_tray_title", { title }, internals);
  }, [internals]);

  const poll = useCallback(async () => {
    // 不并发：tick 与托盘刷新重叠时后到者让位。
    if (stopped.current || busy.current) return;
    if (api === null || identity === null) {
      // 未连接/无身份：清空标题，避免残留上一次环境的告警。
      setTitle(null);
      return;
    }
    const current = generation.current;
    busy.current = true;
    try {
      const scope = resolveScope(identity, loadStoredScope(window.localStorage));
      const data = await loadMenuBarData(api, identity, scope);
      if (current === generation.current) setTitle(alertTitle(alertCount(data.risks)));
    } catch (err) {
      if (current !== generation.current) return;
      if (err instanceof ApiError && err.status === 401) {
        stopped.current = true;
        setTitle(null);
        return;
      }
      // 网络/服务错误：保留上次标题，等下一轮或凭证变化自愈。
    } finally {
      busy.current = false;
    }
  }, [api, identity, setTitle]);

  // 换凭证/重新登录会重建 AdminApi：恢复轮询并作废在途响应。
  useEffect(() => {
    stopped.current = false;
    generation.current++;
  }, [api, identity]);

  useEffect(() => {
    void poll();
    const onTick = () => { void poll(); };
    // 面板切换视角后立即重算（跨窗口 localStorage 会派发 storage 事件）。
    const onStorage = (event: StorageEvent) => {
      if (event.key === MENU_BAR_SCOPE_KEY) void poll();
    };
    window.addEventListener(MENU_TICK_EVENT, onTick);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MENU_TICK_EVENT, onTick);
      window.removeEventListener("storage", onStorage);
    };
  }, [poll]);

  return null;
}
