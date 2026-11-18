import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { AdminApi, KeyRow, ProviderRow } from "../lib/api";
import { parseLimitInput } from "../lib/quota";
import { toErrorMessage } from "../lib/error";
import { formatDateTime } from "../lib/format";
import { useProviderModelCandidates } from "../hooks/useProviderModelCandidates";
import { CUSTOM_PROVIDER_TYPE, PRESET_PROVIDERS, PROTOCOLS, findPresetProvider, presetCategory, selectablePresets, type PresetCategory, type PresetProvider } from "@lutragate/shared";

import { useConfirm } from "./ConfirmModal";
import { Modal } from "./Modal";
import { useToast } from "./Toast";
import { EndpointTestRunner, type EndpointSpec } from "./EndpointTestRunner";
import { DetailPage } from "./SplitDetail";

interface EndpointRow {
  protocol: string;
  url: string;
}

function rowsFromEndpoints(endpoints: Record<string, string | undefined>): EndpointRow[] {
  return Object.entries(endpoints)
    .filter(([, url]) => url !== undefined)
    .map(([protocol, url]) => ({ protocol, url: url! }));
}

/** 供应商分类（preset 加 category 字段）：标签栏只展示有内容的分类。
 * 自定义（含目录外类型）链路同属文本大模型——不单设分类（用户拍板）。 */
type ProviderCategory = PresetCategory;
const CATEGORY_ORDER: ProviderCategory[] = ["text", "image", "embedding"];

/** 行的分类归属：custom / 目录外类型归文本类，其余取 preset.category（缺省 text）。 */
function categoryOf(p: ProviderRow): ProviderCategory {
  if (p.type === CUSTOM_PROVIDER_TYPE) return "text";
  const preset = findPresetProvider(p.type);
  return preset ? presetCategory(preset) : "text";
}

/**
 * 供应商管理（reference 改造二阶段）：列表态 ↔ 编辑态双页切换。
 * 列表态 = 分类标签栏（文本语言/生图模型等，preset.category 驱动、空分类不出
 * 标签）+ 全宽宽行卡片（名称+类型/状态徽标 / 协议+mono 端点 URL+权重+健康度，
 * 行尾「编辑 ›」）；编辑态 = DetailPage 整页（‹ 返回 + 顶部位启停/删除 +
 * 左标签表单 + 分段折叠〔冷却覆盖默认收起〕+ 连通性测试段）——不再用右侧
 * aside（320px 太挤）。脏草稿守卫（#23）汇到返回/Escape。新增/编辑/删除/
 * 启停/服务端转发测试行为与凭证语义零回退（AK/SK 三态在 key 级，本页不涉及）。
 */

/** 供应商行健康度（#21）：由该供应商名下上游 Key 聚合（口径同 KeysPanel 的
 * KeyRow.failure_count / cooldown_until）；无 Key 的供应商零噪音。 */
function providerHealth(keys: KeyRow[], provider: ProviderRow) {
  const own = keys.filter((k) => k.provider_id === provider.id);
  return {
    keyCount: own.length,
    failures: own.reduce((sum, k) => sum + k.failure_count, 0),
    coolingUntil: own.reduce<number>((max, k) => Math.max(max, k.cooldown_until), 0),
  };
}

export function ProvidersPanel({ api }: { api: AdminApi }) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 编辑态："new" = 新建；provider id = 编辑；null = 列表态。 */
  const [editing, setEditing] = useState<string | "new" | null>(null);
  /** 分类标签过滤："all" 或 PresetCategory。 */
  const [categoryTab, setCategoryTab] = useState<string>("all");
  // 脏草稿守卫（#23）：DetailPage 上报脏态；保存回执（saveEpoch）复位。
  const [asideDirty, setAsideDirty] = useState(false);
  const [saveEpoch, setSaveEpoch] = useState(0);
  // 连通性测试模态框（仅编辑已有供应商时可开）。
  const [testOpen, setTestOpen] = useState(false);
  const asideDirtyRef = useRef(false);
  asideDirtyRef.current = asideDirty;

  const refresh = useCallback(async () => {
    try {
      const [providerRows, keyRows] = await Promise.all([api.listProviders(), api.listKeys()]);
      setProviders(providerRows);
      setKeys(keyRows);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleEnabled = async (provider: ProviderRow) => {
    try {
      await api.updateProvider(provider.id, { enabled: provider.enabled === 0 });
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  const { confirmAction, dialog } = useConfirm();
  const { showToast, toast } = useToast();

  /** 关闭守卫（#23）：脏草稿先确认。返回是否已关闭；‹/Escape/取消共用。 */
  const closeEdit = useCallback(async (): Promise<boolean> => {
    if (asideDirtyRef.current && !(await confirmAction(t("common.unsavedConfirm")))) return false;
    setAsideDirty(false);
    setEditing(null);
    setTestOpen(false);
    return true;
  }, [confirmAction, t]);

  const remove = async (provider: ProviderRow) => {
    if (!(await confirmAction(t("providers.deleteConfirm", { name: provider.name })))) return;
    try {
      await api.deleteProvider(provider.id);
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  // 编辑页内容随列表刷新同步：按 id 回找最新行（启停后页面状态跟着变）。
  const editingProvider = editing === "new" || editing === null ? null : providers.find((p) => p.id === editing) ?? null;
  // 列表里已消失的编辑行（删除竞态）自动落回列表态。
  const effectiveEditing = editing !== null && editing !== "new" && editingProvider === null ? null : editing;

  const editPage = effectiveEditing === null ? null : (
    <DetailPage
      title={effectiveEditing === "new" ? t("providers.create") : editingProvider!.name}
      hint={t("providers.editHint")}
      onClose={() => void closeEdit()}
      onDirtyChange={setAsideDirty}
      dirtyResetKey={saveEpoch}
    >
      {/* 健康度提示（冷却/失败）仅在非零时出现；启停/状态不进编辑页（行滑块）。 */}
      {editingProvider !== null && <HealthHint keys={keys} provider={editingProvider} />}
      <ProviderForm
        // key 只挂 id：页面常驻期间的列表刷新（如启停）不重挂表单——
        // 编辑中的草稿不因旁路操作被静默丢弃；保存后表单与已存值天然一致。
        key={effectiveEditing === "new" ? "form-new" : `form-${editingProvider!.id}`}
        api={api}
        provider={editingProvider}
        onDelete={editingProvider !== null ? () => void remove(editingProvider) : undefined}
        onOpenTest={editingProvider !== null ? () => setTestOpen(true) : undefined}
        onDone={() => {
          // 保存回执：递增 epoch 复位脏态（#23），toast 反馈，再刷新列表。
          setSaveEpoch((e) => e + 1);
          showToast(t("providers.savedToast"));
          void refresh();
          // 保存后保持编辑页（新建则回落列表态）。
          if (effectiveEditing === "new") setEditing(null);
        }}
        onCancel={() => void closeEdit()}
      />
    </DetailPage>
  );

  // 分类标签：有供应商即常驻标签栏（全部 + 在用分类，空分类不出标签）——
  // reference 形态要求标签栏是列表的第一层级。
  const categoriesInUse = CATEGORY_ORDER.filter((c) => providers.some((p) => categoryOf(p) === c));
  const visibleProviders = categoryTab === "all" ? providers : providers.filter((p) => categoryOf(p) === categoryTab);

  return (
    <section className="providers-panel">
      {editPage !== null ? (
        editPage
      ) : (
        <>
          <div className="panel-head">
            <h2>{t("providers.title")}</h2>
            <button onClick={() => setEditing("new")}>{t("providers.create")}</button>
          </div>
          <p className="hint">{t("providers.hint")}</p>
          {error && <p className="error" role="alert">{error}</p>}

          {providers.length > 0 && (
            <div className="prov-tabs" role="tablist" aria-label={t("providers.title")}>
              <button
                type="button"
                className={categoryTab === "all" ? "active" : ""}
                onClick={() => setCategoryTab("all")}
              >
                {t("providers.categoryAll")}
              </button>
              {categoriesInUse.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={categoryTab === c ? "active" : ""}
                  onClick={() => setCategoryTab(c)}
                >
                  {t(`providers.category.${c}`)}
                </button>
              ))}
            </div>
          )}

          <div className="rowlist">
            {visibleProviders.map((p) => {
              const health = providerHealth(keys, p);
              const endpointList = PROTOCOLS.filter((protocol) => p.endpoints[protocol] !== undefined);
              return (
                // reference 宽行：左侧信息双行直排（类型徽标 / 格式+权重+健康度，
                // 不显示端点 URL——明细在编辑页），行内启用滑块带文字，
                // 行尾「编辑 ›」进编辑整页。
                <div className="item prov-item" key={p.id}>
                  <span className="prov-main">
                    <span className="item-title">
                      <strong>{p.name}</strong>
                      {/* 供应商类型徽标：custom / 目录外类型显示「自定义」。 */}
                      <span className="badge on">
                        {p.type !== CUSTOM_PROVIDER_TYPE && findPresetProvider(p.type)
                          ? findPresetProvider(p.type)!.label
                          : t("providers.category.custom")}
                      </span>
                    </span>
                    <span className="item-meta">
                      {/* 权重最左 + 固定宽度：多行格式徽标纵向对齐。 */}
                      <span className="prov-weight">{t("providers.weight", { weight: p.weight })}</span>
                      {/* 格式徽标用中性描边样式，与标题行的类型徽标（彩色）区分。 */}
                      {endpointList.map((protocol) => (
                        <span key={protocol} className="badge proto" title={p.endpoints[protocol]}>
                          {t(`protocols.${protocol}`)}
                        </span>
                      ))}
                      {endpointList.length === 0 && (
                        <span className="badge proto off">{t("providers.endpointNone")}</span>
                      )}
                      <HealthBadges health={health} />
                    </span>
                  </span>
                  {/* 行内启用滑块 + 状态文字（启停不进编辑页）。 */}
                  <span className="prov-switch">
                    <span className="prov-switch-label">{p.enabled ? t("providers.enabled") : t("providers.disabled")}</span>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={p.enabled === 1}
                      onChange={() => void toggleEnabled(p)}
                      aria-label={p.enabled ? t("providers.disable") : t("providers.enable")}
                    />
                  </span>
                  <button
                    type="button"
                    className="prov-edit"
                    aria-label={t("providers.editAria", { name: p.name })}
                    onClick={() => setEditing(p.id)}
                  >
                    {t("providers.edit")}
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            {providers.length === 0 && <p className="empty">{t("providers.emptyList")}</p>}
            {providers.length > 0 && visibleProviders.length === 0 && (
              <p className="empty">{t("providers.emptyCategory")}</p>
            )}
          </div>
        </>
      )}

      {dialog}
      {toast}
      {/* 连通性测试模态框：浮于编辑页之上，Escape 只关本层（closeOnEscape 捕获拦截）。
          渲染在 DetailPage 兄弟位——测试 Key 输入不进脏草稿检测（#23 豁免语义同前）。
          key 挂 provider id：测试 Key 不跨供应商残留（#22）。 */}
      {testOpen && editingProvider !== null && (
        <Modal
          title={t("providers.section.connectivity")}
          closeOnEscape
          onClose={() => setTestOpen(false)}
        >
          <ConnectivityTest key={`conn-${editingProvider.id}`} api={api} provider={editingProvider} />
        </Modal>
      )}
    </section>
  );
}

/** 列表行健康徽标（#21）：冷却中（amber 徽标）+ 失败次数（>0 才显示）。 */
function HealthBadges({ health }: { health: ReturnType<typeof providerHealth> }) {
  const { t } = useTranslation();
  const cooling = health.coolingUntil > Date.now();
  return (
    <>
      {cooling && <span className="badge warn">{t("providers.health.cooling")}</span>}
      {health.failures > 0 && (
        <span title={t("providers.health.failuresTitle")}>{t("providers.health.failures", { n: health.failures })}</span>
      )}
    </>
  );
}

/** aside 顶部的健康文案（同口径，完整时间戳）。 */
function HealthHint({ keys, provider }: { keys: KeyRow[]; provider: ProviderRow }) {
  const { t } = useTranslation();
  const health = providerHealth(keys, provider);
  const cooling = health.coolingUntil > Date.now();
  if (!cooling && health.failures === 0) return null;
  return (
    <span className="hint-inline">
      {cooling && t("providers.health.cooldownUntil", { time: formatDateTime(health.coolingUntil) })}
      {cooling && health.failures > 0 && " · "}
      {health.failures > 0 && t("providers.health.failures", { n: health.failures })}
    </span>
  );
}

/** 预置目录按连续段归组（同公司 preset 相邻时合入同一 optgroup，保持目录顺序）。 */
function presetGroups(presets: readonly PresetProvider[]): Array<{ vendor: string | null; presets: PresetProvider[] }> {
  const groups: Array<{ vendor: string | null; presets: PresetProvider[] }> = [];
  for (const p of presets) {
    const last = groups[groups.length - 1];
    if (p.vendor && last?.vendor === p.vendor) last.presets.push(p);
    else groups.push({ vendor: p.vendor ?? null, presets: [p] });
  }
  return groups;
}

function ProviderForm({
  api,
  provider,
  onDelete,
  onOpenTest,
  onDone,
  onCancel,
}: {
  api: AdminApi;
  provider: ProviderRow | null;
  /** 删除（编辑态）：进动作行最左（高危隔离）。 */
  onDelete?: () => void;
  /** 打开连通性测试模态框（编辑态）。 */
  onOpenTest?: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(provider?.name ?? "");
  const [type, setType] = useState(provider?.type ?? CUSTOM_PROVIDER_TYPE);
  const [rows, setRows] = useState<EndpointRow[]>(
    provider ? rowsFromEndpoints(provider.endpoints) : [{ protocol: "openai", url: "" }],
  );
  const [weight, setWeight] = useState(provider?.weight ?? 1);
  // 冷却覆盖（access-control 03）：0/空 = 全局默认（3 次 / 60s）。
  const [cooldownThreshold, setCooldownThreshold] = useState(
    provider && provider.cooldown_failure_threshold > 0 ? String(provider.cooldown_failure_threshold) : "",
  );
  const [cooldownMs, setCooldownMs] = useState(
    provider && provider.cooldown_ms > 0 ? String(provider.cooldown_ms) : "",
  );
  const [error, setError] = useState<string | null>(null);

  const updateRow = (index: number, patch: Partial<EndpointRow>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  // 参考 new-api：选择预置供应商类型时自动填充默认端点与名称（仅当
  // 用户尚未手动修改时覆盖）。
  const pickType = (nextType: string) => {
    setType(nextType);
    const preset = findPresetProvider(nextType);
    if (!preset) return;
    const knownPresetUrls = new Set(
      PRESET_PROVIDERS.flatMap((p) =>
        [p.base_url, p.anthropic_base_url, p.gemini_base_url, p.responses_base_url].filter(Boolean) as string[],
      ),
    );
    const untouched = rows.every((r) => r.url.length === 0 || knownPresetUrls.has(r.url));
    if (untouched) {
      const presetRows: EndpointRow[] = [
        { protocol: "openai", url: preset.base_url },
        ...([
            ["anthropic", preset.anthropic_base_url],
            ["gemini", preset.gemini_base_url],
            ["responses", preset.responses_base_url],
          ] as Array<[string, string | undefined]>)
          .filter(([, url]) => url !== undefined)
          .map(([protocol, url]) => ({ protocol, url: url! })),
      ];
      setRows(presetRows);
    }
    if (name.length === 0) setName(preset.label);
  };

  // 类型下拉逐步放开制（model-discovery 拍板）：只列已验证 preset；
  // 编辑态豁免当前供应商已有类型（存量行不受门槛影响）。
  const groups = presetGroups(selectablePresets(provider?.type));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const filled = rows.filter((r) => r.url.trim().length > 0);
    if (filled.length === 0) {
      setError(t("providers.form.errEndpointRequired"));
      return;
    }
    if (filled.length < rows.length) {
      setError(t("providers.form.errEndpointIncomplete"));
      return;
    }
    const protocols = new Set(filled.map((r) => r.protocol));
    if (protocols.size !== filled.length) {
      setError(t("providers.form.errEndpointDup"));
      return;
    }
    const endpoints = Object.fromEntries(filled.map((r) => [r.protocol, r.url.trim()]));
    const cooldowns = {
      cooldown_failure_threshold: parseLimitInput(cooldownThreshold),
      cooldown_ms: parseLimitInput(cooldownMs),
    };
    try {
      if (provider) {
        await api.updateProvider(provider.id, { name, type, endpoints, weight, ...cooldowns });
      } else {
        await api.createProvider({ name, type, endpoints, weight, ...cooldowns });
      }
      onDone();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  return (
    <form className="detail-fields" onSubmit={submit}>
      {/* #21 分段折叠：基本设置与端点默认展开，冷却覆盖默认收起（高级设置）。 */}
      <details className="aside-fold" open>
        <summary>{t("providers.section.basic")}</summary>
        <div className="detail-fields">
          {/* reference 编辑页左标签布局：label 左固定宽、控件右占满（field-row）。 */}
          <label className="field-row">
            {t("providers.form.type")}
            <select value={type} onChange={(e) => pickType(e.target.value)}>
              <option value={CUSTOM_PROVIDER_TYPE}>{t("providers.form.custom")}</option>
              {/* 同公司多条 preset 用 optgroup 树形分组（连续段归组，保持目录顺序）。 */}
              {groups.map((group) =>
                group.vendor !== null ? (
                  <optgroup key={group.vendor} label={group.vendor}>
                    {group.presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}{p.self_hosted ? "" : `（${p.base_url}）`}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  group.presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}{p.self_hosted ? "" : `（${p.base_url}）`}
                    </option>
                  ))
                ),
              )}
            </select>
          </label>
          <label className="field-row">
            {t("providers.form.name")}
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
        </div>
      </details>
      <details className="aside-fold" open>
        <summary>{t("providers.section.endpoints")}</summary>
        <div className="detail-fields">
          <div className="form-label">{t("providers.form.endpointsTitle")}</div>
          {rows.map((row, index) => (
            <div className="endpoint-row" key={index}>
              <select
                value={row.protocol}
                onChange={(e) => updateRow(index, { protocol: e.target.value })}
                aria-label={t("providers.form.endpointProtocol")}
              >
                {PROTOCOLS.map((protocol) => (
                  <option key={protocol} value={protocol}>
                    {t(`protocols.${protocol}`)}
                  </option>
                ))}
              </select>
              <input
                value={row.url}
                onChange={(e) => updateRow(index, { url: e.target.value })}
                placeholder="https://api.example.com"
                aria-label={t("providers.form.endpointUrl", { protocol: t(`protocols.${row.protocol}`) })}
              />
              {/* 单行时不渲染删除按钮：常驻 disabled 红字易误读为错误状态。 */}
              {rows.length > 1 && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                  aria-label={t("providers.form.removeEndpoint")}
                >
                  {t("providers.form.removeEndpoint")}
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setRows((prev) => {
                const used = new Set(prev.map((r) => r.protocol));
                const next = PROTOCOLS.find((protocol) => !used.has(protocol)) ?? "openai";
                return [...prev, { protocol: next, url: "" }];
              })
            }
          >
            {t("providers.form.addEndpoint")}
          </button>
          <label className="field-row">
            {t("providers.form.weight")}
            <input type="number" min={1} value={weight} onChange={(e) => setWeight(Number(e.target.value))} required />
          </label>
          <p className="hint-inline">{t("providers.form.weightHint")}</p>
        </div>
      </details>
      <details className="aside-fold">
        <summary>{t("providers.section.cooldown")}</summary>
        <div className="detail-fields">
          <label className="field-row">
            {t("providers.form.cooldownThreshold")}
            <input type="number" min={0} step={1} value={cooldownThreshold}
              onChange={(e) => setCooldownThreshold(e.target.value)} placeholder={t("providers.form.cooldownThresholdPh")} />
          </label>
          <label className="field-row">
            {t("providers.form.cooldownMs")}
            <input type="number" min={0} step={1} value={cooldownMs}
              onChange={(e) => setCooldownMs(e.target.value)} placeholder={t("providers.form.cooldownMsPh")} />
          </label>
          <p className="hint">{t("providers.form.cooldownHint")}</p>
        </div>
      </details>
      {error && <p className="error" role="alert">{error}</p>}
      {/* 动作行（reference 编辑页）：删除靠左高危隔离；测试连接/取消/保存靠右。 */}
      <div className="form-actions">
        {provider && onDelete && (
          <button type="button" className="danger form-actions-lead" onClick={onDelete}>
            {t("providers.delete")}
          </button>
        )}
        {provider && onOpenTest && (
          <button type="button" onClick={onOpenTest}>{t("providers.section.connectivity")}</button>
        )}
        <button type="button" onClick={onCancel}>{t("providers.form.cancel")}</button>
        <button type="submit" className="primary">{provider ? t("providers.form.save") : t("providers.form.create")}</button>
      </div>
    </form>
  );
}

/**
 * 供应商级连通性测试（spec §3.7）：手输测试 Key，按端点逐个经服务端转发
 * （model-discovery 03：不依赖上游 CORS）。由动作行「连通性测试」按钮以
 * 模态框承载（模态渲染在 DetailPage 兄弟位，输入不进脏草稿检测）。
 */
function ConnectivityTest({ api, provider }: { api: AdminApi; provider: ProviderRow }) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const specs: EndpointSpec[] = (["openai", "anthropic"] as const)
    .filter((protocol) => provider.endpoints[protocol] !== undefined)
    .map((protocol) => ({ protocol, baseUrl: provider.endpoints[protocol]! }));
  const preset = findPresetProvider(provider.type);
  // 模型候选（model-discovery 01）：优先上游 models 实时列表，失败回落预设
  // 静态清单（与映射表单同一回落语义），表单永远可手填。
  const { models: candidates, source } = useProviderModelCandidates(api, provider.id, preset?.suggested_models);

  return (
    <div>
      <p className="hint">{t("connectivity.hint")}</p>
      <div className="detail-fields">
        <label>
          {t("connectivity.key")}
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={t("connectivity.keyPh")} />
        </label>
        <EndpointTestRunner
          specs={specs}
          model={model}
          onModelChange={setModel}
          placeholder={preset?.suggested_models[0] ?? "glm-4.5 / deepseek-chat"}
          modelCandidates={candidates ?? []}
          hint={
            <small className="hint-inline">
              {source === "upstream" && t("connectivity.sourceUpstream", { count: candidates?.length ?? 0 })}
              {source === "preset" && t("connectivity.sourcePreset")}
              {source === "none" && t("connectivity.sourceNone")}
            </small>
          }
          run={async (protocol) => {
            // 提交校验：服务端要求 api_key ≥4 字符（否则 400），不足直接拦下不发请求
            // （自托管宿主 Ollama 实录：<4 字符曾令测试按钮永久卡死）。错误只进端点结果行
            // ——#22 去重：客户端拦截与服务端失败各只呈现一次，不再叠加 aside 级 alert。
            if (apiKey.length < 4) {
              return { ok: false, latencyMs: 0, error: t("connectivity.keyTooShort") };
            }
            try {
              // 服务端转发（03）：手输 Key 走 POST /admin/providers/:id/test，
              // 不依赖上游 CORS（火山方舟无 CORS 头，客户端直连在 WebView 必 Load failed）。
              return await api.testProvider(provider.id, { api_key: apiKey, model: model.trim() || undefined, protocol });
            } catch (err) {
              return { ok: false, latencyMs: 0, error: toErrorMessage(err) };
            }
          }}
        />
      </div>
    </div>
  );
}
