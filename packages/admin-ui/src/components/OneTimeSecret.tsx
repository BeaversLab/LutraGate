import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Modal } from "./Modal";

/**
 * 一次性凭证展示（multi-user 06）：lgm_/lgk_ 明文只在创建/重置响应中出现
 * 一次。确认关闭即由父组件丢弃状态，之后无法再次查看；因为丢了只能重发，
 * 遮罩点击**不**关闭——必须走「我已保存，关闭」。凭证旁提供一键复制。
 */
export function OneTimeSecret({
  title,
  secret,
  hint,
  onAck,
}: {
  title: string;
  secret: string;
  hint?: string;
  onAck: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板不可用（非安全上下文/权限拒绝）——保持默认：用户手动选中复制。
    }
  };

  return (
    // 防误触：一次性凭证不接受遮罩关闭（noop），见组件注释。
    <Modal title={title} onClose={() => {}}>
      <p className="hint">仅此一次展示，关闭后无法再次查看，请立即妥善保存。{hint}</p>
      <div className="secret-row">
        <code className="mono secret" role="note">{secret}</code>
        <button
          type="button"
          onClick={copy}
          aria-label="复制"
          title="复制到剪贴板"
          className={copied ? "copied" : undefined}
        >
          {copied ? "已复制" : (
            <>
              <Copy size={14} aria-hidden="true" />
              复制
            </>
          )}
        </button>
      </div>
      <div className="form-actions">
        <button type="button" className="primary" onClick={onAck}>我已保存，关闭</button>
      </div>
    </Modal>
  );
}
