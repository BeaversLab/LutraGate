import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { PROVIDER_USAGE_TYPES } from "@lutragate/core";
import type { AdminApi, KeyRow, ProviderRow } from "../lib/api";
import { formatLimit, parseLimitInput } from "../lib/quota";
import { toErrorMessage } from "../lib/error";
import { formatDateTime } from "../lib/format";
import { useConfirm } from "./ConfirmModal";
import { Modal } from "./Modal";
import { useToast } from "./Toast";
import { PROTOCOLS, findPresetProvider } from "@lutragate/shared";
import { EndpointTestRunner, type EndpointSpec } from "./EndpointTestRunner";
import { KeyUsageCell } from "./KeyUsageCell";
import { DetailPage } from "./SplitDetail";

/**
 * 管控面凭证 UI 配置（前端编码控制，provider-usage 04 的 key 级形态）：
 * 仅收录的供应商类型显示「管控面凭证」入口，提示文案按类型取 i18n
 * （keys.credHints.*）。智谱的用量查询不需要管控凭证（裸 Key 直查），
 * DeepSeek 等无用量适配器的类型天然不收录。
 */
const CREDENTIALS_UI: Record<string, { hintKey: string }> = {
  volcengine: { hintKey: "keys.credHints.volcengine" },
  "volcengine-plan": { hintKey: "keys.credHints.volcenginePlan" },
};

/** 最后使用时间的相对文案（复用 usage.* 键）：刚刚 / N 分钟前 / N 小时前，
 * 超过一天回落本地日期时间（列表无需天级键）。 */
export function formatLastUsed(ts: number, now: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const minutes = Math.max(0, Math.floor((now - ts) / 60_000));
  if (minutes < 1) return t("keys.usage.justNow");
  if (minutes < 60) return t("keys.usage.minutesAgo", { n: minutes });
  if (minutes < 60 * 24) return t("keys.usage.hoursAgo", { n: Math.floor(minutes / 60) });
  return formatDateTime(ts);
}

/**
 * 上游 Key 管理（reference 改造，同供应商面板形态）：列表态 = 供应商筛选 +
 * 尾号搜索 + 卡片式宽行（供应商+尾号+健康度 / 限额摘要 / 套餐用量条，行尾
 * 启用滑块+「编辑 ›」）；编辑态 = DetailPage 整页（限额主表单 + 凭证折叠段 +
 * 用量折叠段，动作行 删除靠左 / 测试连接·取消·保存靠右），连通性测试走模态框
 * （服务端解密该 Key，无需手输 Key）。Key 明文只在创建提交时出现一次并即刻在
 * 服务端加密，列表与编辑页仅展示尾号——无复制完整密钥的入口（明文不可恢复）。
 */
export function KeysPanel({ api }: { api: AdminApi }) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 编辑态："new" = 新建模式；key id = 编辑；null = 列表态。 */
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [providerFilter, setProviderFilter] = useState("all");
  const [search, setSearch] = useState("");
  /** 连通性测试/管控面凭证模态框（仅编辑已有 Key 时可开）。 */
  const [testOpen, setTestOpen] = useState(false);
  const [credOpen, setCredOpen] = useState(false);
  // 凭证模态框的 AK 输入框引用（「去填写」引导聚焦）。
  const akInputRef = useRef<HTMLInputElement | null>(null);
  // 脏草稿守卫（#23）：DetailPage 上报脏态；保存回执（saveEpoch）复位。
  const [asideDirty, setAsideDirty] = useState(false);
  const [saveEpoch, setSaveEpoch] = useState(0);
  const asideDirtyRef = useRef(false);
  asideDirtyRef.current = asideDirty;
  const { showToast, toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const [k, p] = await Promise.all([api.listKeys(), api.listProviders()]);
      setKeys(k);
      setProviders(p);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  const providerType = (id: string) => providers.find((p) => p.id === id)?.type ?? "";

  const { confirmAction, dialog } = useConfirm();

  /** 关闭守卫（#23）：脏草稿先确认；‹/Escape/取消共用。 */
  const closeEdit = useCallback(async (): Promise<boolean> => {
    if (asideDirtyRef.current && !(await confirmAction(t("common.unsavedConfirm")))) return false;
    setAsideDirty(false);
    setEditing(null);
    setTestOpen(false);
    setCredOpen(false);
    return true;
  }, [confirmAction, t]);

  const toggle = async (key: KeyRow) => {
    try {
      await api.setKeyEnabled(key.id, key.enabled === 0);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  /** 异常恢复：清零失败计数并立即解除冷却（列表卡片「恢复冷却」按钮）。 */
  const resetCooldown = async (key: KeyRow) => {
    try {
      await api.resetKeyCooldown(key.id);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  const remove = async (key: KeyRow) => {
    const confirmed = await confirmAction(
      t("keys.deleteConfirm", { provider: providerName(key.provider_id), hint: key.key_hint }),
    );
    if (!confirmed) return;
    try {
      await api.deleteKey(key.id);
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  /** 保存回执：复位脏态（#23）+ toast + 刷新列表。 */
  const onSaved = useCallback(() => {
    setSaveEpoch((e) => e + 1);
    showToast(t("keys.savedToast"));
    void refresh();
  }, [showToast, t, refresh]);

  // 列表筛选：供应商下拉 + 尾号/供应商名搜索（叠加过滤）。
  const query = search.trim().toLowerCase();
  const visibleKeys = keys.filter((k) => {
    if (providerFilter !== "all" && k.provider_id !== providerFilter) return false;
    if (query.length === 0) return true;
    return k.key_hint.toLowerCase().includes(query) || providerName(k.provider_id).toLowerCase().includes(query);
  });

  // 编辑页内容随列表刷新同步：按 id 回找最新行；列表里已消失的编辑行（删除
  // 竞态）自动落回列表态。
  const editingKey = editing === "new" || editing === null ? null : keys.find((k) => k.id === editing) ?? null;
  const effectiveEditing = editing !== null && editing !== "new" && editingKey === null ? null : editing;

  const editPage = effectiveEditing === null ? null : (
    <DetailPage
      title={
        effectiveEditing === "new"
          ? t("keys.create")
          : t("keys.asideTitle", { provider: providerName(editingKey!.provider_id) })
      }
      hint={effectiveEditing === "new" ? t("keys.createHint") : t("keys.secretNote", { hint: editingKey!.key_hint })}
      onClose={() => void closeEdit()}
      onDirtyChange={setAsideDirty}
      dirtyResetKey={saveEpoch}
    >
      {effectiveEditing === "new" ? (
        <AddKeyForm
          api={api}
          providers={providers}
          onDone={() => {
            onSaved();
            setEditing(null); // 新建回落列表态
          }}
          onCancel={() => void closeEdit()}
        />
      ) : (
        <KeyLimitsForm
          // key 挂 key id：同 id 的列表刷新（启停/凭证保存）不重挂表单——编辑
          // 草稿保留；换对象 = 整段重挂（草稿归零）。
          key={editingKey!.id}
          api={api}
          row={editingKey!}
          onDelete={() => remove(editingKey!)}
          onOpenTest={() => setTestOpen(true)}
          onOpenCredentials={
            CREDENTIALS_UI[providerType(editingKey!.provider_id)] !== undefined ? () => setCredOpen(true) : undefined
          }
          onDone={onSaved}
          onCancel={() => void closeEdit()}
        />
      )}
    </DetailPage>
  );

  return (
    <section>
      {editPage !== null ? (
        editPage
      ) : (
        <>
          <div className="panel-head">
            <h2>{t("keys.title")}</h2>
            <button onClick={() => setEditing("new")} disabled={providers.length === 0}>
              {t("keys.create")}
            </button>
          </div>
          {/* 说明行常驻占位（nbsp 保行高）：标题区高度与供应商页节奏一致；
              没有引导文字时留空。 */}
          <p className="hint">{providers.length === 0 ? t("keys.needProvider") : "\u00A0"}</p>
          {error && <p className="error" role="alert">{error}</p>}

          <div className="filters">
            <select aria-label={t("keys.filterLabel")} value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)}>
              <option value="all">{t("keys.filterAll")}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <input
              type="search"
              aria-label={t("keys.searchLabel")}
              placeholder={t("keys.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* 卡片式宽行（reference）：供应商+尾号+健康度 / 限额摘要 / 套餐用量条
              直排行内；行尾 启用滑块（带状态文字）+「编辑 ›」。 */}
          <div className="rowlist">
            {visibleKeys.map((k) => {
              const pType = providerType(k.provider_id);
              const usageSupported = (PROVIDER_USAGE_TYPES as readonly string[]).includes(pType);
              return (
                <div className="item prov-item" key={k.id}>
                  <span className="prov-main">
                    <span className="item-title">
                      <strong>{providerName(k.provider_id)}</strong>
                      <span className="mono">****{k.key_hint}</span>
                      {k.cooldown_until > Date.now() && (
                        <>
                          <span className="badge warn">{t("providers.health.cooling")}</span>
                          {/* 异常恢复入口就在异常处：清失败计数 + 立即解除冷却。 */}
                          <button
                            type="button"
                            className="reset-cooldown"
                            title={t("keys.resetCooldownTitle")}
                            onClick={() => void resetCooldown(k)}
                          >
                            {t("keys.resetCooldown")}
                          </button>
                        </>
                      )}
                      {k.failure_count > 0 && <span>{t("keys.failuresLabel", { n: k.failure_count })}</span>}
                    </span>
                    <span className="item-meta">
                      {/* 限额逐字段标名（值经 formatLimit：0 = 不限）。 */}
                      <span>{t("keys.tokenLimit")}：{formatLimit(k.daily_token_limit)}</span>
                      <span>{t("keys.requestLimit")}：{formatLimit(k.daily_request_limit)}</span>
                    </span>
                    {usageSupported && (
                      <KeyUsageCell
                        api={api}
                        keyRow={k}
                        providerType={pType}
                        onSetupCredentials={() => {
                          // 去填写：进编辑页并直接打开凭证模态框（聚焦 AK）。
                          setEditing(k.id);
                          setCredOpen(true);
                        }}
                      />
                    )}
                  </span>
                  {/* 最后使用时间（滑块左侧）；无日志不显示。 */}
                  {k.last_used_at ? (
                    <span className="prov-switch-label key-last-used" title={formatDateTime(k.last_used_at)}>
                      {t("keys.lastUsed", { time: formatLastUsed(k.last_used_at, Date.now(), (k, o) => t(k, o ?? {})) })}
                    </span>
                  ) : null}
                  {/* 行内启用滑块 + 状态文字（启停不进编辑页）。 */}
                  <span className="prov-switch">
                    <span className="prov-switch-label">{k.enabled ? t("keys.statusOn") : t("keys.statusOff")}</span>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={k.enabled === 1}
                      onChange={() => void toggle(k)}
                      aria-label={k.enabled ? t("keys.disable") : t("keys.enable")}
                    />
                  </span>
                  <button
                    type="button"
                    className="prov-edit"
                    aria-label={t("keys.editAria", { provider: providerName(k.provider_id), hint: k.key_hint })}
                    onClick={() => setEditing(k.id)}
                  >
                    {t("providers.edit")}
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            {visibleKeys.length === 0 && (
              <p className="empty">
                {/* 两种空态分开：真没数据 vs 筛选/搜索无匹配（#15 走查纠正）。 */}
                {keys.length === 0 ? t("keys.emptyList") : t("keys.emptyFiltered")}
              </p>
            )}
          </div>
        </>
      )}

      {dialog}
      {toast}
      {/* 连通性测试模态框：浮于编辑页之上，Escape 只关本层（closeOnEscape 捕获拦截）。
          渲染在 DetailPage 兄弟位——测试模型输入不进脏草稿检测（#23 豁免语义同前）。
          key 挂 key id：测试模型不跨 Key 残留。 */}
      {testOpen && editingKey !== null && (
        <Modal
          title={t("connectivity.title")}
          closeOnEscape
          onClose={() => setTestOpen(false)}
        >
          <KeyTestRunner key={`keytest-${editingKey.id}`} api={api} providers={providers} keyRow={editingKey} />
        </Modal>
      )}
      {/* 管控面凭证模态框（AK/SK）：同上形态；key 挂 key id，打开即聚焦 AK。
          提示文案按供应商类型取（CREDENTIALS_UI.hintKey）。 */}
      {credOpen && editingKey !== null && (
        <Modal
          title={t("keys.credentialsTitle")}
          closeOnEscape
          onClose={() => setCredOpen(false)}
        >
          <KeyCredentialsFields
            key={`cred-${editingKey.id}`}
            api={api}
            row={editingKey}
            hint={t(CREDENTIALS_UI[providerType(editingKey.provider_id)]?.hintKey ?? "keys.credentialsHint")}
            akInputRef={akInputRef}
            onDone={onSaved}
          />
        </Modal>
      )}
    </section>
  );
}

/** 编辑页主表单（资产级日限额，quota）：两数字，空/0 = 不限；动作行承载
 * 删除（靠左高危隔离）/ 凭证·测试连接 / 取消 / 保存。 */
function KeyLimitsForm({
  api,
  row,
  onDelete,
  onOpenTest,
  onOpenCredentials,
  onDone,
  onCancel,
}: {
  api: AdminApi;
  row: KeyRow;
  onDelete?: () => void;
  onOpenTest?: () => void;
  onOpenCredentials?: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [tokenLimit, setTokenLimit] = useState(row.daily_token_limit > 0 ? String(row.daily_token_limit) : "");
  const [requestLimit, setRequestLimit] = useState(row.daily_request_limit > 0 ? String(row.daily_request_limit) : "");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.updateKeyLimits(row.id, {
        daily_token_limit: parseLimitInput(tokenLimit),
        daily_request_limit: parseLimitInput(requestLimit),
      });
      onDone();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  return (
    <form className="detail-fields" onSubmit={submit}>
      <p className="hint">{t("keys.limitsHint")}</p>
      <label className="field-row">
        {t("keys.tokenLimit")}
        <input type="number" min={0} step={1} value={tokenLimit} onChange={(e) => setTokenLimit(e.target.value)} placeholder={formatLimit(0)} />
      </label>
      <label className="field-row">
        {t("keys.requestLimit")}
        <input type="number" min={0} step={1} value={requestLimit} onChange={(e) => setRequestLimit(e.target.value)} placeholder={formatLimit(0)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        {onDelete && (
          <button type="button" className="danger form-actions-lead" onClick={onDelete}>
            {t("keys.delete")}
          </button>
        )}
        {onOpenCredentials && (
          <button type="button" onClick={onOpenCredentials}>{t("keys.credentialsAction")}</button>
        )}
        {onOpenTest && (
          <button type="button" onClick={onOpenTest}>{t("connectivity.title")}</button>
        )}
        <button type="button" onClick={onCancel}>{t("keys.cancel")}</button>
        <button type="submit" className="primary">{t("keys.save")}</button>
      </div>
    </form>
  );
}

/** 新建表单（编辑整页）：明文 Key 只在这次提交中出现并立即在服务端加密。 */
function AddKeyForm({
  api,
  providers,
  onDone,
  onCancel,
}: {
  api: AdminApi;
  providers: ProviderRow[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [apiKey, setApiKey] = useState("");
  const [tokenLimit, setTokenLimit] = useState("");
  const [requestLimit, setRequestLimit] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.createKey({
        provider_id: providerId,
        api_key: apiKey,
        daily_token_limit: parseLimitInput(tokenLimit),
        daily_request_limit: parseLimitInput(requestLimit),
      });
      onDone();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  return (
    <form className="detail-fields" onSubmit={submit}>
      <label className="field-row">
        {t("keys.providerLabel")}
        <select value={providerId} onChange={(e) => setProviderId(e.target.value)} required>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <label className="field-row">
        {t("keys.apiKeyLabel")}
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." required minLength={4} />
      </label>
      <label className="field-row">
        {t("keys.tokenLimit")}
        <input type="number" min={0} step={1} value={tokenLimit} onChange={(e) => setTokenLimit(e.target.value)} placeholder={formatLimit(0)} />
      </label>
      <label className="field-row">
        {t("keys.requestLimit")}
        <input type="number" min={0} step={1} value={requestLimit} onChange={(e) => setRequestLimit(e.target.value)} placeholder={formatLimit(0)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>{t("keys.cancel")}</button>
        <button type="submit" className="primary">{t("keys.submitCreate")}</button>
      </div>
    </form>
  );
}

/**
 * 管控面凭证编辑（provider-usage 04，key 级）：火山 IAM AK/SK，用于套餐用量
 * 查询。服务端不回显已存凭证 → 留空保存 = 保持不变；「清除凭证」显式置空。
 */
function KeyCredentialsFields({
  api,
  row,
  hint,
  akInputRef,
  onDone,
}: {
  api: AdminApi;
  row: KeyRow;
  /** 按供应商类型的提示文案（CREDENTIALS_UI.hintKey 经 i18n 解析）。 */
  hint: string;
  akInputRef: React.RefObject<HTMLInputElement | null>;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 模态框打开即聚焦 AK（「去填写」引导的落点；手动打开同样受益）。
  useEffect(() => {
    akInputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 全空提交 = 保持不变（服务端不回显已存凭证，无从预填）；半填才是错误。
    if (accessKeyId.length === 0 && secretAccessKey.length === 0) return;
    if (accessKeyId.length === 0 || secretAccessKey.length === 0) {
      setError(t("keys.errHalf"));
      return;
    }
    try {
      await api.updateKeyCredentials(row.id, {
        type: "volcengine_ak_sk",
        access_key_id: accessKeyId.trim(),
        secret_access_key: secretAccessKey.trim(),
      });
      onDone();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  const clear = async () => {
    try {
      await api.updateKeyCredentials(row.id, null);
      onDone();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  return (
    <form className="detail-fields" onSubmit={submit}>
      <p className="hint">{hint}</p>
      <label className="field-row">
        {t("keys.akLabel")}
        <input
          ref={akInputRef}
          type="text"
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
          placeholder="AKLT..."
          autoComplete="off"
        />
      </label>
      <label className="field-row">
        {t("keys.skLabel")}
        <input
          type="password"
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
          placeholder="SK..."
          autoComplete="new-password"
        />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="danger" onClick={clear}>{t("keys.clearCredentials")}</button>
        <button type="submit" className="primary">{t("keys.saveCredentials")}</button>
      </div>
    </form>
  );
}

/** Key 级连通性测试（模态框内）：服务端解密该 Key，按端点逐个直连供应商。 */
function KeyTestRunner({
  api,
  providers,
  keyRow,
}: {
  api: AdminApi;
  providers: ProviderRow[];
  keyRow: KeyRow;
}) {
  const { t } = useTranslation();
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const provider = providers.find((p) => p.id === keyRow.provider_id);
  const preset = findPresetProvider(provider?.type ?? "");
  const specs: EndpointSpec[] = PROTOCOLS
    .filter((protocol) => provider?.endpoints[protocol] !== undefined)
    .map((protocol) => ({ protocol, baseUrl: provider!.endpoints[protocol]! }));

  return (
    <div>
      <p className="hint">{t("keys.testHint")}</p>
      <EndpointTestRunner
        specs={specs}
        model={model}
        onModelChange={setModel}
        placeholder={preset?.suggested_models[0] ?? t("connectivity.modelPh")}
        modelCandidates={preset?.suggested_models ?? []}
        run={async (protocol) => {
          try {
            setError(null);
            return await api.testKey(keyRow.id, { model: model || undefined, protocol });
          } catch (err) {
            setError(toErrorMessage(err));
            return { ok: false, latencyMs: 0, error: toErrorMessage(err) };
          }
        }}
      />
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
