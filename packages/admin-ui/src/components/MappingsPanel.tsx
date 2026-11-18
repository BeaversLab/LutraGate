import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { AdminApi, MappingRow, ProviderRow } from "../lib/api";
import { toErrorMessage } from "../lib/error";
import { findPresetProvider } from "@lutragate/shared";
import { useProviderModelCandidates } from "../hooks/useProviderModelCandidates";
import { useConfirm } from "./ConfirmModal";
import { DetailPage } from "./SplitDetail";

/**
 * 模型映射：列表平铺表（客户端别名 → 供应商/上游模型，两列语义明确——别名
 * 不代表厂商）+ 编辑/新建/导入整页（DetailPage，对齐供应商与 Key 管理形态；
 * aside 320px 对导入候选列表太挤）。弹窗只保留破坏性二次确认（useConfirm）。
 * 启停是行内滑块（不进编辑页，同供应商拍板）。导入的实时候选/回落 preset/
 * 部分失败重试语义不变（model-discovery 01）。
 */
export function MappingsPanel({ api }: { api: AdminApi }) {
  const { t } = useTranslation();
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 编辑态："new" = 新建；"import" = 从上游导入；mapping id = 编辑；null = 列表态。 */
  const [editing, setEditing] = useState<string | "new" | "import" | null>(null);
  // 脏草稿守卫（#23）：同 ProvidersPanel 的四路径守卫。
  const [editDirty, setEditDirty] = useState(false);
  const editDirtyRef = useRef(false);
  editDirtyRef.current = editDirty;
  const [saveEpoch, setSaveEpoch] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [m, p] = await Promise.all([api.listMappings(), api.listProviders()]);
      setMappings(m);
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

  const { confirmAction, dialog } = useConfirm();

  /** 关闭守卫（#23）：脏草稿先确认；‹/Escape/取消共用。 */
  const closeEdit = useCallback(async (): Promise<boolean> => {
    if (editDirtyRef.current && !(await confirmAction(t("common.unsavedConfirm")))) return false;
    setEditDirty(false);
    setEditing(null);
    return true;
  }, [confirmAction, t]);

  const remove = async (mapping: MappingRow) => {
    const confirmed = await confirmAction(
      t("mappings.deleteConfirm", {
        client: mapping.client_model,
        provider: providerName(mapping.provider_id),
        upstream: mapping.upstream_model,
      }),
    );
    if (!confirmed) return;
    try {
      await api.deleteMapping(mapping.id);
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  const toggle = async (mapping: MappingRow) => {
    try {
      await api.updateMapping(mapping.id, { enabled: mapping.enabled === 0 });
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  // 编辑页内容随列表刷新同步：按 id 回找最新行（启停后页面状态跟着变）；
  // 列表里已消失的编辑行（删除竞态）自动落回列表态。
  const editingMapping =
    editing === null || editing === "new" || editing === "import"
      ? null
      : mappings.find((m) => m.id === editing) ?? null;
  const effectiveEditing =
    editing !== null && editing !== "new" && editing !== "import" && editingMapping === null
      ? null
      : editing;

  // 按客户端别名排序（稳定排序保持同别名内渠道顺序）：相同别名的多渠道
  // 相邻聚齐，替代分组结构（数量级不到，平铺表是 demo 拍板形态）。
  const sortedMappings = useMemo(
    () => [...mappings].sort((a, b) => a.client_model.localeCompare(b.client_model)),
    [mappings],
  );

  // 搜索过滤（同 KeysPanel 形态）：匹配别名 / 供应商名 / 上游模型。
  const [search, setSearch] = useState("");
  const searchLower = search.trim().toLowerCase();
  const visibleMappings = useMemo(
    () =>
      sortedMappings.filter(
        (m) =>
          searchLower.length === 0 ||
          m.client_model.toLowerCase().includes(searchLower) ||
          m.upstream_model.toLowerCase().includes(searchLower) ||
          providerName(m.provider_id).toLowerCase().includes(searchLower),
      ),
    [sortedMappings, searchLower, providers],
  );

  const editPage = effectiveEditing === null ? null : (
    <DetailPage
      title={
        effectiveEditing === "new"
          ? t("mappings.create")
          : effectiveEditing === "import"
            ? t("mappings.importTitle")
            : editingMapping!.client_model
      }
      hint={effectiveEditing === "import" ? t("mappings.importHint") : t("mappings.editHint")}
      onClose={() => void closeEdit()}
      onDirtyChange={setEditDirty}
      dirtyResetKey={saveEpoch}
    >
      {effectiveEditing === "new" && (
        <MappingForm
          api={api}
          providers={providers}
          mapping={null}
          onDone={() => {
            void refresh();
            setEditing(null); // 新建回落列表态
          }}
          onCancel={() => void closeEdit()}
        />
      )}
      {effectiveEditing === "import" && (
        <ImportFromUpstream
          api={api}
          providers={providers}
          mappings={mappings}
          initialProviderId={providers[0]?.id ?? ""}
          onDone={() => {
            setEditing(null);
            void refresh();
          }}
          onCancel={() => void closeEdit()}
        />
      )}
      {editingMapping !== null && (
        // key 挂 mapping id：同 id 刷新不重挂表单（草稿保留），切行重挂（#15 教训）。
        <MappingForm
          key={editingMapping.id}
          api={api}
          providers={providers}
          mapping={editingMapping}
          onDelete={() => remove(editingMapping)}
          onDone={() => {
            setSaveEpoch((e) => e + 1);
            void refresh();
          }}
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
            <h2>{t("mappings.title")}</h2>
            {/* 动作按钮成组（.panel-actions）：panel-head 是 space-between，
                裸摆多个按钮会被空隙拆散。 */}
            <span className="panel-actions">
              <button onClick={() => setEditing("new")} disabled={providers.length === 0}>
                {t("mappings.create")}
              </button>
              <button onClick={() => setEditing("import")} disabled={providers.length === 0}>
                {t("mappings.import")}
              </button>
            </span>
          </div>
          {/* 说明行常驻：语义取列表口径（映射+权重分流+别名不代表厂商）；
              无供应商时换成引导文案。 */}
          <p className="hint">{providers.length === 0 ? t("mappings.needProvider") : t("mappings.hint")}</p>
          {error && <p className="error" role="alert">{error}</p>}

          <div className="filters">
            <input
              type="search"
              aria-label={t("mappings.searchLabel")}
              placeholder={t("mappings.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("mappings.colClient")}</th>
                    <th>{t("mappings.colProvider")}</th>
                    <th>{t("mappings.colUpstream")}</th>
                    <th>{t("mappings.colStatus")}</th>
                    <th aria-hidden="true"></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMappings.map((m) => (
                    <tr
                      key={m.id}
                      tabIndex={0}
                      onClick={() => setEditing(m.id)}
                      // 键盘可达（tabIndex 配套，#18 先例）：Enter/Space = 进编辑页。
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setEditing(m.id);
                        }
                      }}
                    >
                      <td className="mono">{m.client_model}</td>
                      <td>{providerName(m.provider_id)}</td>
                      <td className="mono">{m.upstream_model}</td>
                      <td>
                        {/* 行内启用滑块 + 状态文字（同供应商形态）；点击不冒泡触发行编辑。 */}
                        <span className="prov-switch">
                          <span className="prov-switch-label">
                            {m.enabled ? t("providers.enabled") : t("providers.disabled")}
                          </span>
                          <input
                            type="checkbox"
                            className="switch"
                            checked={m.enabled === 1}
                            onChange={() => void toggle(m)}
                            aria-label={
                              m.enabled ? t("mappings.disable") : t("mappings.enable")
                            }
                            onClick={(e) => e.stopPropagation()}
                          />
                        </span>
                      </td>
                      {/* 行尾显式编辑入口（同供应商「编辑 ›」）：行点击可点性无视觉
                          提示，按钮补 affordance；点击冒泡到行 onClick 即可。 */}
                      <td className="row-edit-cell">
                        <button type="button" className="row-edit">
                          {t("mappings.edit")}
                          <ChevronRight size={14} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {mappings.length === 0 && (
                    <tr><td colSpan={5} className="empty">{t("mappings.emptyList")}</td></tr>
                  )}
                  {mappings.length > 0 && visibleMappings.length === 0 && (
                    <tr><td colSpan={5} className="empty">{t("mappings.emptyFiltered")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {dialog}
    </section>
  );
}

/**
 * 从上游导入（model-discovery 01）：拉上游模型
 * 列表 → 排除该供应商已有 client_model → 勾选 → 批量建映射（client_model =
 * upstream_model）。部分失败不关面板，成功项移出候选——重试只打失败项。
 */
function ImportFromUpstream({
  api,
  providers,
  mappings,
  initialProviderId,
  onDone,
  onCancel,
}: {
  api: AdminApi;
  providers: ProviderRow[];
  mappings: MappingRow[];
  initialProviderId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [providerId, setProviderId] = useState(initialProviderId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 本次会话已成功导入的模型：失败重试时不再重复提交（防 409 假失败）。 */
  const [imported, setImported] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = findPresetProvider(providers.find((p) => p.id === providerId)?.type ?? "");
  const { models, source } = useProviderModelCandidates(api, providerId, preset?.suggested_models);

  // 已有 client_model（按供应商）→ 批量插入撞 UNIQUE (client_model, provider_id)，先排除。
  const existing = useMemo(() => {
    const set = new Set<string>();
    for (const m of mappings) {
      if (m.provider_id === providerId) set.add(m.client_model);
    }
    return set;
  }, [mappings, providerId]);

  // 切供应商时清空勾选与已导入记录（两者按供应商维度）。
  useEffect(() => {
    setSelected(new Set());
    setImported(new Set());
    setError(null);
  }, [providerId]);

  const available = (models ?? []).filter((m) => !existing.has(m) && !imported.has(m));

  const toggle = (model: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    let created = 0;
    const failures: string[] = [];
    for (const model of available.filter((m) => selected.has(m))) {
      try {
        await api.createMapping({ client_model: model, provider_id: providerId, upstream_model: model });
        created += 1;
        // 成功项移出候选与勾选集：再次点导入只重试失败项。
        setImported((prev) => new Set(prev).add(model));
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(model);
          return next;
        });
      } catch (err) {
        failures.push(`${model}: ${toErrorMessage(err)}`);
      }
    }
    setBusy(false);
    if (failures.length > 0) {
      setError(t("mappings.importPartialFail", { created, failed: failures.length, detail: failures.join("\n") }));
      return;
    }
    onDone();
  };

  return (
    // 候选勾选是临时交互，不算编辑草稿（#23 脏检测豁免）。
    <div className="detail-fields" data-dirty-ignore="">
      <label>
        {t("mappings.providerLabel")}
        <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      {models === null && <p className="hint">{t("mappings.importLoading")}</p>}
      {models !== null && available.length === 0 && (
        <p className="hint">
          {models.length === 0 ? t("mappings.importEmptyUpstream") : t("mappings.importAllImported")}
        </p>
      )}
      {models !== null && available.length > 0 && (
        <>
          <p className="hint">
            {source === "upstream"
              ? t("mappings.importSourceUpstreamNote", { count: available.length })
              : t("mappings.importSourcePresetNote")}
          </p>
          <div className="form-label">
            <button type="button" onClick={() => setSelected(new Set(available))}>{t("mappings.importSelectAll")}</button>
            <button type="button" onClick={() => setSelected(new Set())}>{t("mappings.importClearAll")}</button>
            {t("mappings.importSelectedCount", { n: selected.size, total: available.length })}
          </div>
          <ul className="import-candidates">
            {available.map((model) => (
              <li key={model}>
                <label>
                  <input type="checkbox" checked={selected.has(model)} onChange={() => toggle(model)} />
                  <span className="mono">{model}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="error error-pre" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>{t("mappings.cancel")}</button>
        <button
          type="button"
          className="primary"
          onClick={submit}
          disabled={busy || available.length === 0 || selected.size === 0}
        >
          {busy ? t("mappings.importing") : t("mappings.importButton", { n: selected.size })}
        </button>
      </div>
    </div>
  );
}

/** 映射编辑表单（编辑页内）：供应商 → 上游模型（候选下拉+手输）→ 客户端模型名。
 * 删除按钮仅在编辑态出现（动作行靠左，同供应商编辑页）。 */
function MappingForm({
  api,
  providers,
  mapping,
  onDelete,
  onDone,
  onCancel,
}: {
  api: AdminApi;
  providers: ProviderRow[];
  mapping: MappingRow | null;
  /** 编辑态的删除回调（新建态不渲染删除按钮）。 */
  onDelete?: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [providerId, setProviderId] = useState(mapping?.provider_id ?? providers[0]?.id ?? "");
  const [upstreamModel, setUpstreamModel] = useState(mapping?.upstream_model ?? "");
  const [clientModel, setClientModel] = useState(mapping?.client_model ?? "");
  /** 客户端模型名被手动编辑后不再跟随上游预填（model-discovery 01 拍板交互）。 */
  const [clientTouched, setClientTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 上游模型发现（model-discovery 01）：实时列表优先，拉不到（未配 Key /
  // 上游不提供 / 网络失败）回落该供应商预设的静态清单，表单永远可手填。
  const preset = findPresetProvider(providers.find((p) => p.id === providerId)?.type ?? "");
  const { models, source: suggestionFrom } = useProviderModelCandidates(api, providerId, preset?.suggested_models);
  const suggestions = models ?? [];

  const onUpstreamModelChange = (value: string) => {
    setUpstreamModel(value);
    // 客户端模型名未手动编辑时跟随上游模型名预填同名。
    if (!clientTouched) setClientModel(value);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (mapping) {
        await api.updateMapping(mapping.id, { client_model: clientModel, provider_id: providerId, upstream_model: upstreamModel });
      } else {
        await api.createMapping({ client_model: clientModel, provider_id: providerId, upstream_model: upstreamModel });
      }
      onDone();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  return (
    <form className="detail-fields" onSubmit={submit}>
      {/* 左标签网格（field-row，同供应商编辑页）：标签列固定 96px，控件列对齐。 */}
      <label className="field-row">
        {t("mappings.providerLabel")}
        <select value={providerId} onChange={(e) => setProviderId(e.target.value)} required>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <label className="field-row">
        {t("mappings.upstreamLabel")}
        <span className="model-combo">
          <input
            value={upstreamModel}
            onChange={(e) => onUpstreamModelChange(e.target.value)}
            placeholder="gpt-4o-2024-11-20"
            required
          />
          {/* 候选下拉替代 datalist（原生缺陷：选中后再打开按当前值过滤，无法
              换选）——恒回空位，选中只回填输入框，可连续换选（同 EndpointTestRunner）。 */}
          {suggestions.length > 0 && (
            <select
              className="model-candidates"
              value=""
              aria-label={t("connectivity.modelCandidates")}
              onChange={(e) => {
                if (e.target.value !== "") onUpstreamModelChange(e.target.value);
              }}
            >
              {/* 空位项文字 = 候选来源提示（收起时可见），不再是裸 ▾。 */}
              <option value="">{t("connectivity.modelCandidates")} ▾</option>
              {suggestions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          )}
        </span>
      </label>
      <p className="hint-inline">
        {suggestionFrom === "upstream" && t("connectivity.sourceUpstream", { count: suggestions.length })}
        {suggestionFrom === "preset" && t("connectivity.sourcePreset")}
        {suggestionFrom === "none" && t("connectivity.sourceNone")}
      </p>
      <label className="field-row">
        {t("mappings.clientLabel")}
        <input
          value={clientModel}
          onChange={(e) => {
            setClientTouched(true);
            setClientModel(e.target.value);
          }}
          placeholder="gpt-4o"
          required
        />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      {/* 动作行（同供应商编辑页）：删除靠左高危隔离；取消/保存靠右。 */}
      <div className="form-actions">
        {mapping && onDelete && (
          <button type="button" className="danger form-actions-lead" onClick={onDelete}>
            {t("mappings.delete")}
          </button>
        )}
        <button type="button" onClick={onCancel}>{t("mappings.cancel")}</button>
        <button type="submit" className="primary">{mapping ? t("mappings.save") : t("mappings.createSubmit")}</button>
      </div>
    </form>
  );
}
