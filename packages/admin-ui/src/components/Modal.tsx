import { useEffect, useRef } from "react";

/** 通用模态框：遮罩左键点击关闭，内容阻止冒泡。
 * 误关守卫（WKWebView 实测）：右键释放也会派发 click（button≠0 不关）；
 * 弹窗内选中文字拖到遮罩上释放时 click 落在遮罩（有选区不关，防复制误关）。
 * closeOnEscape：Escape 关闭本弹窗，并在捕获阶段拦截——页面级 DetailPage/
 * DetailAside 的 document Escape 监听不再收到（弹窗浮于编辑页之上，Escape
 * 只关最上层）。 */
export function Modal({
  title,
  onClose,
  closeOnEscape,
  children,
}: {
  title: string;
  onClose: () => void;
  closeOnEscape?: boolean;
  children: React.ReactNode;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [closeOnEscape]);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.button !== 0) return;
        if ((window.getSelection()?.toString() ?? "") !== "") return;
        onClose();
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
