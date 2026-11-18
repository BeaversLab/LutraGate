import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatLatency } from "../lib/connectivity";

/** 按端点逐个测试并展示结果（每个配置的端点一行）。 */

export interface EndpointSpec {
  protocol: "openai" | "anthropic";
  baseUrl: string;
}

export interface EndpointOutcome {
  ok: boolean;
  latencyMs: number;
  error?: string;
  replyPreview?: string;
}

const PROTOCOL_LABEL: Record<EndpointSpec["protocol"], string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

export function EndpointTestRunner({
  specs,
  run,
  model,
  onModelChange,
  placeholder,
  modelCandidates,
  hint,
}: {
  specs: EndpointSpec[];
  run: (protocol: EndpointSpec["protocol"]) => Promise<EndpointOutcome>;
  model: string;
  onModelChange: (model: string) => void;
  placeholder?: string;
  /** 候选模型清单：渲染为输入框旁的候选下拉（替代 datalist——其原生行为
   * 在选中一项后再打开会按当前值过滤，必须清空输入框才能选其他项）。 */
  modelCandidates?: readonly string[];
  hint?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [outcomes, setOutcomes] = useState<Partial<Record<EndpointSpec["protocol"], EndpointOutcome | "pending">>>({});
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setOutcomes(Object.fromEntries(specs.map((s) => [s.protocol, "pending" as const])));
    try {
      for (const spec of specs) {
        const outcome = await run(spec.protocol);
        setOutcomes((prev) => ({ ...prev, [spec.protocol]: outcome }));
      }
    } catch (err) {
      // 兜底（自托管宿主 Ollama 卡死实录）：run 抛异常时剩余 pending 落成失败并复位
      // busy——测试弹窗绝不允许「测试中…」永久挂死。
      const message = err instanceof Error ? err.message : String(err);
      setOutcomes((prev) => {
        const next = { ...prev };
        for (const s of specs) {
          if (next[s.protocol] === "pending") next[s.protocol] = { ok: false, latencyMs: 0, error: message };
        }
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label>
        {t("connectivity.model")}
        <span className="model-combo">
          <input value={model} onChange={(e) => onModelChange(e.target.value)} placeholder={placeholder} />
          {/* 候选下拉恒回空位（选中只回填输入框），可连续换选；手输不受影响。 */}
          {(modelCandidates?.length ?? 0) > 0 && (
            <select
              className="model-candidates"
              value=""
              aria-label={t("connectivity.modelCandidates")}
              onChange={(e) => {
                if (e.target.value !== "") onModelChange(e.target.value);
              }}
            >
              {/* 空位项文字 = 候选来源提示（收起时可见），不再是裸 ▾。 */}
              <option value="">{t("connectivity.modelCandidates")} ▾</option>
              {modelCandidates!.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          )}
        </span>
      </label>
      {hint}
      <ul className="endpoint-tests">
        {specs.map((spec) => {
          const outcome = outcomes[spec.protocol];
          return (
            <li key={spec.protocol} className="endpoint-test-row">
              <span className="badge on">{PROTOCOL_LABEL[spec.protocol]}</span>
              <span className="mono endpoint-url" title={spec.baseUrl}>{spec.baseUrl}</span>
              <span className="endpoint-result">
                {outcome === undefined && <span className="hint">{t("connectivity.notTested")}</span>}
                {outcome === "pending" && <span className="hint">{t("connectivity.testing")}</span>}
                {typeof outcome === "object" &&
                  (outcome.ok ? (
                    <span className="ok">{t("connectivity.ok", { latency: formatLatency(outcome.latencyMs) })}{outcome.replyPreview ? ` — ${outcome.replyPreview}` : ""}</span>
                  ) : (
                    <span className="error">{t("connectivity.failed", { latency: formatLatency(outcome.latencyMs), error: outcome.error ?? t("connectivity.unknownError") })}</span>
                  ))}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="form-actions">
        <button type="button" className="primary" onClick={start} disabled={busy || specs.length === 0}>
          {busy ? t("connectivity.testing") : specs.length > 1 ? t("connectivity.runAll", { count: specs.length }) : t("connectivity.runOne")}
        </button>
      </div>
    </>
  );
}
