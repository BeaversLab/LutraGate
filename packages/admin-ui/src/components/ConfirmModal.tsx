import { useCallback, useState } from "react";
import { Modal } from "./Modal";

interface PendingConfirm {
  message: string;
  resolve: (confirmed: boolean) => void;
}

/**
 * 页内二次确认 hook（桌面联验修复）：window.confirm 在 Tauri 的 WKWebView 里
 * 静默返回 false（wry 未实现 WKUIDelegate 的 JS 对话框回调），桌面端所有破坏性
 * 确认都会「没反应」。改走 Modal 弹窗，Web 与桌面同一条代码路径；Promise 风格
 * 保持调用点 `if (!(await confirmAction(...))) return;` 形状不变。
 * 用法：组件里 `const { confirmAction, dialog } = useConfirm();` 并在根节点渲染 `{dialog}`。
 */
export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirmAction = useCallback(
    (message: string) =>
      new Promise<boolean>((resolve) => {
        setPending({ message, resolve });
      }),
    [],
  );
  const settle = (confirmed: boolean) => {
    pending?.resolve(confirmed);
    setPending(null);
  };
  const dialog =
    pending === null ? null : (
      <Modal title="确认操作" onClose={() => settle(false)}>
        <p className="confirm-message">{pending.message}</p>
        <div className="form-actions">
          <button onClick={() => settle(false)}>取消</button>
          <button className="danger" onClick={() => settle(true)}>确认</button>
        </div>
      </Modal>
    );
  return { confirmAction, dialog };
}
