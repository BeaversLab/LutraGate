import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { AdminApi, MyGrantsResult } from "../lib/api";
import { normalizeBaseUrl } from "../lib/envs";
import { toErrorMessage } from "../lib/error";
import { DetailAside, SplitLayout } from "./SplitDetail";

/**
 * 可用模型（multi-user 07；UI 2.0 #19 起为 split 布局，user 视图；打磨轮
 * 2026-11-16 对齐行卡/连接方式升级）：左列表自己可路由的模型（/admin/me/grants，
 * 与 /v1/models 同一授权收敛结果）+ 搜索；右详情 aside = 连接方式（客户端模型
 * ID / 网关地址 = 当前环境地址 + /v1 / API Key 用自己的 lgk_ 占位，不展示真实
 * 凭证）+ 可一键复制的 OpenAI 兼容 curl 示例（占位 Key，改一词即可跑通第一个
 * 请求）。无授权时单一空态引导（不再分区块重复）。列表下方保留被分配的上游
 * 供应商与 key 尾号。
 */
export function MyModelsPanel({ api, baseUrl }: { api: AdminApi; baseUrl: string }) {
  const { t } = useTranslation();
  const [grants, setGrants] = useState<MyGrantsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setGrants(await api.getMyGrants());
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const models = (grants?.models ?? []).filter((m) => m.toLowerCase().includes(search.trim().toLowerCase()));
  // aside 内容随列表筛选同步：选中行被筛掉时自动收起。
  const effectiveSelected = selected !== null && models.includes(selected) ? selected : null;

  const aside = effectiveSelected === null ? null : (
    <ModelConnectAside model={effectiveSelected} baseUrl={baseUrl} onClose={() => setSelected(null)} />
  );

  return (
    <section>
      <div className="panel-head">
        <h2>{t("myModels.title")}</h2>
      </div>
      <p className="hint">{t("myModels.hint")}</p>
      {error && <p className="error" role="alert">{error}</p>}

      {grants !== null && (
        grants.grants.length === 0 ? (
          // 无上游授权 = 单一空态：模型与「被分配的 Key」空表是同一件事，不分区块重复。
          <p className="empty">{t("myModels.noGrants")}</p>
        ) : (
          <SplitLayout
            aside={aside}
            list={
              <>
                <div className="section-head">
                  <h3>{t("myModels.listTitle")}</h3>
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("myModels.searchLabel")}
                    aria-label={t("myModels.searchLabel")}
                  />
                </div>
                <div className="rowlist">
                  {models.map((m) => (
                    <div className="item prov-item" key={m}>
                      <span className="prov-main">
                        <span className="item-title">
                          <strong className="mono">{m}</strong>
                        </span>
                      </span>
                      <button
                        type="button"
                        className="prov-edit"
                        aria-label={t("myModels.viewHowAria", { model: m })}
                        onClick={() => setSelected(m)}
                      >
                        {t("myModels.viewHow")}
                        <ChevronRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                  {models.length === 0 && (
                    <p className="empty">{search.trim() === "" ? t("myModels.emptyList") : t("myModels.emptyFiltered")}</p>
                  )}
                </div>

                <h3>{t("myModels.grantedTitle")}</h3>
                <table>
                  <thead>
                    <tr><th>{t("myModels.colProvider")}</th><th>{t("myModels.colHint")}</th></tr>
                  </thead>
                  <tbody>
                    {grants.grants.map((g) => (
                      <tr key={g.id}>
                        <td>{g.provider_name}</td>
                        <td className="mono">****{g.key_hint}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            }
          />
        )
      )}
    </section>
  );
}

/** 模型连接方式 aside：事实区（模型 ID / 网关地址 / Key 占位）+ 可一键复制的
 * OpenAI 兼容 curl 示例（占位 Key，绝不触碰真实凭证）。说明只留一段（Key 去
 * 「我的 Key」创建 + 凭证安全口径），复制按钮只复制模型 ID、Base URL 与示例。 */
function ModelConnectAside({
  model,
  baseUrl,
  onClose,
}: {
  model: string;
  baseUrl: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<"model" | "baseUrl" | "example" | null>(null);
  const gatewayBase = `${normalizeBaseUrl(baseUrl)}/v1`;
  const apiKey = t("myModels.apiKeyPlaceholder");
  const curl = [
    `curl ${gatewayBase}/chat/completions \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Authorization: Bearer ${apiKey}" \\`,
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}]}'`,
  ].join("\n");
  // 复制反馈的回落计时器：aside 关闭（重挂）时清掉，避免对已卸载组件 setState。
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
  }, []);

  const copy = async (what: "model" | "baseUrl" | "example", value: string) => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(what);
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(null), 2000);
    } catch {
      // 剪贴板不可用（非安全上下文/权限拒绝）——保持默认：用户手动选中复制。
    }
  };

  return (
    <DetailAside title={model} onClose={onClose}>
      <dl className="revoke-facts">
        <div><dt>{t("myModels.factModel")}</dt><dd className="mono">{model}</dd></div>
        <div><dt>{t("myModels.factBaseUrl")}</dt><dd className="mono">{gatewayBase}</dd></div>
        <div><dt>{t("myModels.factApiKey")}</dt><dd className="mono">{apiKey}</dd></div>
      </dl>
      <p className="hint">{t("myModels.keyPointer")}</p>
      <div className="form-actions">
        <button type="button" onClick={() => void copy("model", model)}>
          {copied === "model" ? t("myModels.copied") : t("myModels.copyModel")}
        </button>
        <button type="button" onClick={() => void copy("baseUrl", gatewayBase)}>
          {copied === "baseUrl" ? t("myModels.copied") : t("myModels.copyBaseUrl")}
        </button>
      </div>

      <h3>{t("myModels.exampleTitle")}</h3>
      <pre className="error-pre example-pre mono">{curl}</pre>
      <div className="form-actions">
        <button type="button" onClick={() => void copy("example", curl)}>
          {copied === "example" ? t("myModels.copied") : t("myModels.copyExample")}
        </button>
      </div>
    </DetailAside>
  );
}
