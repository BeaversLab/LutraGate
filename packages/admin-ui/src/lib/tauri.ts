/** Tauri 环境探测（desktop 01/03 共用）：探测不到返回 null 走 Web 路径，零构建期分叉。 */

export interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

/**
 * 运行时探测 `__TAURI_INTERNALS__`（桌面 WebView 才有）。SecretStore（secrets.ts）
 * 与 LogStore（logstore.detect.ts）的探测同源于此，避免两份拷贝漂移。
 */
export function detectTauriInternals(
  internals: TauriInternals | null | undefined = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals })
    .__TAURI_INTERNALS__,
): TauriInternals | null {
  if (internals === null || internals === undefined || typeof internals.invoke !== "function") return null;
  return internals;
}

/** 发一条即发即忘的壳命令：非桌面/失败都静默（壳命令不影响前端功能）。 */
export function safeInvoke(
  command: string,
  args?: Record<string, unknown>,
  internals: TauriInternals | null = detectTauriInternals(),
): void {
  const request = args === undefined ? internals?.invoke(command) : internals?.invoke(command, args);
  void request?.catch(() => {
    // 壳命令失败不阻断前端。
  });
}

/** 面板里的「打开 LutraGate」：把主窗口带回前台（连接/首次引导只在主窗口可达）。 */
export function showMainWindow(internals: TauriInternals | null = detectTauriInternals()): void {
  safeInvoke("show_main_window", undefined, internals);
}
