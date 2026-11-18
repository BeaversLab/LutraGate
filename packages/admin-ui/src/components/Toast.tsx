import { useCallback, useEffect, useRef, useState } from "react";

/** toast 停留时长：足够读完一句反馈、又不会遮挡后续操作。 */
const TOAST_MS = 3000;

/**
 * 全局 toast（UI 2.0 #11）：操作反馈统一入口（保存/删除等），3 秒自动消失，
 * 不打断操作。与 useConfirm 同构的小 hook —— 在壳层挂 `{toast}`，调用点
 * `showToast(message)`。role="status" 供读屏器播报。
 */
export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const showToast = useCallback((next: string) => {
    setMessage(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), TOAST_MS);
  }, []);

  const toast = message === null ? null : <div className="toast" role="status">{message}</div>;
  return { showToast, toast };
}
