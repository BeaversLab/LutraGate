import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { AccessKeyRow, AdminApi, Identity, UsageRow } from "../lib/api";
import { formatLimit, indexUsageByKey, localMidnight, parseLimitInput, remaining, usageTokens } from "../lib/quota";
import { credentialStatus, dateInputToExpiry, expiryToDateInput, formatDate, formatExpiry, parseCidrList } from "../lib/access-control";
import { toErrorMessage } from "../lib/error";
import { useConfirm } from "./ConfirmModal";
import { OneTimeSecret } from "./OneTimeSecret";
import { StatusBadge } from "./StatusBadge";
import { DetailPage } from "./SplitDetail";
import { useToast } from "./Toast";

/**
 * 我的 Key（multi-user 07；打磨轮对齐 Key 管理形态，2026-11-16）：列表态 =
 * 搜索 + 卡片宽行（名称/尾号/状态徽标 + 限额摘要/过期/今日用量余量条，行尾
 * 行内启停滑块 +「编辑 ›」）；编辑/创建 = DetailPage 整页（事实区 + 名称/日
 * token/日请求数/并发三限额/过期日期/IP 白名单表单，动作行 删除靠左｜取消·保存
 * 靠右；启停只在列表行内滑块）。明文仅创建响应中经 OneTimeSecret 一次性展示。
 * 状态按 expires_at 与本地时间推导（启用/已禁用/已过期），过期相对展示。
 * user 角色的范围由服务端 SQL 钉死；administrator 的列表服务端返回全部，
 * 这里按 identity.user_id 收窄。
 */
export function MyKeysPanel({ api, identity }: { api: AdminApi; identity?: Identity }) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<AccessKeyRow[]>([]);
  const [usageBy, setUsageBy] = useState<Map<string, UsageRow>>(new Map());
  const [error, setError] = useState<string | null>(null);
  /** 编辑态："new" = 创建；key id = 编辑；null = 列表态。 */
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [search, setSearch] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  // 脏草稿守卫（#23）：DetailPage 上报脏态；保存回执（saveEpoch）复位。
  const [asideDirty, setAsideDirty] = useState(false);
  const [saveEpoch, setSaveEpoch] = useState(0);
  const asideDirtyRef = useRef(false);
  asideDirtyRef.current = asideDirty;
  const { showToast, toast } = useToast();

  // administrator 的自助视图钉在自己的 user 上（服务端对 admin 返回全集）。
  const selfUserId = identity?.role === "administrator" ? identity.id : null;

  const refresh = useCallback(async () => {
    try {
      // 当日（本地午夜起）按 key 聚合——次数列与余量的「已用」来源。
      const [keyRows, usage] = await Promise.all([
        api.listAccessKeys(),
        api.getUsage({
          group_by: "key",
          from: localMidnight(),
          ...(selfUserId ? { user_id: selfUserId } : {}),
        }),
      ]);
      setKeys(selfUserId ? keyRows.filter((k) => k.user_id === selfUserId) : keyRows);
      setUsageBy(indexUsageByKey(usage.usage));
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [api, selfUserId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { confirmAction, dialog } = useConfirm();

  /** 关闭守卫（#23）：脏草稿先确认；‹/Escape/取消共用。 */
  const closeEdit = useCallback(async (): Promise<boolean> => {
    if (asideDirtyRef.current && !(await confirmAction(t("common.unsavedConfirm")))) return false;
    setAsideDirty(false);
    setEditing(null);
    return true;
  }, [confirmAction, t]);

  /** 行内启停（即时生效，PUT enabled）；不进编辑页。 */
  const toggle = async (key: AccessKeyRow) => {
    try {
      await api.updateAccessKey(key.id, { enabled: !key.enabled });
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  /** 删除（原「吊销」）：useConfirm 确认（含尾号与 401 提示）后 DELETE。 */
  const remove = async (key: AccessKeyRow) => {
    const confirmed = await confirmAction(
      t("myKeys.revokeConfirm", { name: key.name, hint: `****${key.key_hint}` }),
    );
    if (!confirmed) return;
    try {
      await api.deleteAccessKey(key.id);
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  /** 保存回执：复位脏态 + toast + 刷新列表。 */
  const onSaved = useCallback(() => {
    setSaveEpoch((e) => e + 1);
    showToast(t("myKeys.savedToast"));
    void refresh();
  }, [showToast, t, refresh]);

  // 列表搜索：名称 / 尾号（叠加过滤）。
  const query = search.trim().toLowerCase();
  const visibleKeys = keys.filter(
    (k) => query.length === 0 || k.name.toLowerCase().includes(query) || k.key_hint.toLowerCase().includes(query),
  );

  // 编辑页内容随列表刷新同步：按 id 回找最新行；列表里已消失的编辑行（删除
  // 竞态）自动落回列表态。
  const editingKey = editing === "new" || editing === null ? null : keys.find((k) => k.id === editing) ?? null;
  const effectiveEditing = editing !== null && editing !== "new" && editingKey === null ? null : editing;

  const editPage = effectiveEditing === null ? null : (
    <DetailPage
      title={effectiveEditing === "new" ? t("myKeys.create") : editingKey!.name}
      hint={effectiveEditing === "new" ? t("myKeys.createHint") : t("myKeys.editHint")}
      onClose={() => void closeEdit()}
      onDirtyChange={setAsideDirty}
      dirtyResetKey={saveEpoch}
    >
      {effectiveEditing === "new" ? (
        <CreateKeyForm
          api={api}
          onDone={() => {
            onSaved();
            setEditing(null); // 凭证弹窗承接收尾，由列表承接选择
          }}
          onCancel={() => void closeEdit()}
          onIssued={(plaintext) => setIssued(plaintext)}
        />
      ) : (
        <KeyDetail
          // key 挂 key id：同 id 刷新不重挂（草稿保留），切行重挂（#15 教训）。
          key={editingKey!.id}
          api={api}
          row={editingKey!}
          usage={usageBy.get(editingKey!.id)}
          onDelete={() => void remove(editingKey!)}
          onSaved={onSaved}
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
            <h2>{t("myKeys.title")}</h2>
            <button onClick={() => setEditing("new")}>{t("myKeys.create")}</button>
          </div>
          {/* 功能性说明行（明文仅展示一次 + 配额语义）：占标题下 hint 位。 */}
          <p className="hint">{t("myKeys.listHint")}</p>
          {error && <p className="error" role="alert">{error}</p>}

          <div className="filters">
            <input
              type="search"
              aria-label={t("myKeys.searchLabel")}
              placeholder={t("myKeys.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* 卡片式宽行（同 Key 管理）：名称/尾号/状态徽标 + 限额摘要/过期/
              今日用量余量条直排行内；行尾 启停滑块（带状态文字）+「编辑 ›」。 */}
          <div className="rowlist">
            {visibleKeys.map((k) => (
              <div className="item prov-item" key={k.id}>
                <span className="prov-main">
                  <span className="item-title">
                    <strong>{k.name}</strong>
                    <span className="mono">****{k.key_hint}</span>
                    <StatusBadge status={credentialStatus({ enabled: k.enabled, expires_at: k.expires_at })} />
                  </span>
                  <span className="item-meta">
                    <span>{t("myKeys.tokenLimit")}：{formatLimit(k.daily_token_limit)}</span>
                    <span>{t("myKeys.requestLimit")}：{formatLimit(k.daily_request_limit)}</span>
                    <span>{t("myKeys.facts.expiry")}：{formatExpiry(k.expires_at)}</span>
                  </span>
                  <QuotaUsage usage={usageBy.get(k.id)} row={k} />
                </span>
                {/* 行内启停滑块 + 状态文字（启停不进编辑页）。 */}
                <span className="prov-switch">
                  <span className="prov-switch-label">{k.enabled ? t("myKeys.statusOn") : t("myKeys.statusOff")}</span>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={k.enabled}
                    onChange={() => void toggle(k)}
                    aria-label={k.enabled ? t("myKeys.disable") : t("myKeys.enable")}
                  />
                </span>
                <button
                  type="button"
                  className="prov-edit"
                  aria-label={t("myKeys.editAria", { name: k.name, hint: k.key_hint })}
                  onClick={() => setEditing(k.id)}
                >
                  {t("myKeys.edit")}
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
            {visibleKeys.length === 0 && (
              <p className="empty">
                {/* 两种空态分开：真没数据 vs 搜索无匹配（KeysPanel 先例）。 */}
                {keys.length === 0 ? t("myKeys.emptyList") : t("myKeys.emptyFiltered")}
              </p>
            )}
          </div>
        </>
      )}

      {issued !== null && (
        <OneTimeSecret
          title={t("myKeys.issuedTitle")}
          secret={issued}
          hint={t("myKeys.issuedHint")}
          onAck={() => setIssued(null)}
        />
      )}
      {dialog}
      {toast}
    </section>
  );
}

/** 编辑页：事实区（只读）+ 编辑表单（名称/三限额/过期/IP）+ 动作行
 * 删除靠左（useConfirm）｜取消·保存靠右；启停由列表行内滑块承担。 */
function KeyDetail({
  api,
  row,
  usage,
  onDelete,
  onSaved,
  onCancel,
}: {
  api: AdminApi;
  row: AccessKeyRow;
  usage?: UsageRow;
  onDelete: () => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(row.name);
  const [error, setError] = useState<string | null>(null);
  const limits = useLimitInputs(row);
  // 过期日期输入（空 = 永不过期）与 IP 白名单多行文本（回填现有列表）。
  const [expiresOn, setExpiresOn] = useState(expiryToDateInput(row.expires_at));
  const [ipList, setIpList] = useState(row.ip_allowlist.join("\n"));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const expiresAt = dateInputToExpiry(expiresOn);
    if (expiresAt < 0) {
      setError(t("myKeys.invalidDate"));
      return;
    }
    const parsed = parseCidrList(ipList);
    if (parsed.error !== null) {
      setError(parsed.error);
      return;
    }
    try {
      await api.updateAccessKey(row.id, { name, ...limits.parsed, expires_at: expiresAt, ip_allowlist: parsed.list });
      onSaved();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  return (
    <>
      <dl className="revoke-facts">
        <div><dt>{t("myKeys.facts.hint")}</dt><dd className="mono">****{row.key_hint}</dd></div>
        <div><dt>{t("myKeys.facts.status")}</dt><dd><StatusBadge status={credentialStatus({ enabled: row.enabled, expires_at: row.expires_at })} /></dd></div>
        <div><dt>{t("myKeys.facts.expiry")}</dt><dd>{formatExpiry(row.expires_at)}</dd></div>
        <div><dt>{t("myKeys.facts.createdAt")}</dt><dd>{formatDate(row.created_at)}</dd></div>
        <div><dt>{t("myKeys.facts.todayUsage")}</dt><dd><QuotaUsage usage={usage} row={row} /></dd></div>
      </dl>

      <form className="detail-fields" onSubmit={submit}>
        <label className="field-row">
          {t("myKeys.nameLabel")}
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        {limits.fields}
        <label className="field-row">
          {t("myKeys.expiryField")}
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </label>
        <label className="field-row">
          {t("myKeys.ipField")}
          <textarea
            rows={3}
            className="mono input-muted"
            value={ipList}
            onChange={(e) => setIpList(e.target.value)}
            placeholder={"10.0.0.0/8\n2001:db8::/32"}
            aria-label={t("myKeys.ipAria")}
          />
        </label>
        <p className="hint-inline">{t("myKeys.ipFieldHint")}</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="danger form-actions-lead" onClick={onDelete}>
            {t("myKeys.revoke")}
          </button>
          <button type="button" onClick={onCancel}>{t("myKeys.cancel")}</button>
          <button type="submit" className="primary">{t("myKeys.save")}</button>
        </div>
      </form>
    </>
  );
}

/** 已用/限额/余量两行（请求、tokens）+ 余量条；0 = 不限；越限余量钉 0。
 * dash-status 02 起导出共用（我的仪表盘状态卡同渲染）。 */
export function QuotaUsage({ usage, row }: { usage?: UsageRow; row: AccessKeyRow }) {
  const { t } = useTranslation();
  const requests = usage?.requests ?? 0;
  const tokens = usageTokens(usage);
  const line = (used: number, limit: number) => {
    const rest = remaining(used, limit);
    return `${used.toLocaleString()} / ${formatLimit(limit)}${rest === null ? "" : t("quota.remaining", { n: rest.toLocaleString() })}`;
  };
  const bar = (used: number, limit: number) => {
    if (limit <= 0) return null;
    const pct = Math.min(100, Math.round((used / limit) * 100));
    return (
      <span className="quota-bar" role="presentation">
        <span style={{ width: `${pct}%` }} className={pct >= 100 ? "full" : undefined} />
      </span>
    );
  };
  return (
    <span className="quota-usage">
      <span className="quota-line">
        {t("quota.requests")} {line(requests, row.daily_request_limit)}
        {bar(requests, row.daily_request_limit)}
      </span>
      <span className="quota-line">
        {t("quota.tokens")} {line(tokens, row.daily_token_limit)}
        {bar(tokens, row.daily_token_limit)}
      </span>
      {row.max_concurrency > 0 && <span>{t("quota.concurrency", { n: row.max_concurrency })}</span>}
    </span>
  );
}

/** 三个数字输入的受控状态：字符串输入，提交时 parseLimitInput（空 = 不限）。 */
function useLimitInputs(initial: { daily_token_limit: number; daily_request_limit: number; max_concurrency: number }) {
  const { t } = useTranslation();
  const [token, setToken] = useState(initial.daily_token_limit > 0 ? String(initial.daily_token_limit) : "");
  const [request, setRequest] = useState(initial.daily_request_limit > 0 ? String(initial.daily_request_limit) : "");
  const [concurrency, setConcurrency] = useState(initial.max_concurrency > 0 ? String(initial.max_concurrency) : "");
  return {
    token, request, concurrency,
    setToken, setRequest, setConcurrency,
    fields: (
      <>
        <label className="field-row">
          {t("myKeys.tokenLimit")}
          <input type="number" min={0} step={1} value={token} onChange={(e) => setToken(e.target.value)} placeholder={t("quota.unlimited")} />
        </label>
        <label className="field-row">
          {t("myKeys.requestLimit")}
          <input type="number" min={0} step={1} value={request} onChange={(e) => setRequest(e.target.value)} placeholder={t("quota.unlimited")} />
        </label>
        <label className="field-row">
          {t("myKeys.concurrencyLimit")}
          <input type="number" min={0} step={1} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} placeholder={t("quota.unlimited")} />
        </label>
      </>
    ),
    parsed: {
      daily_token_limit: parseLimitInput(token),
      daily_request_limit: parseLimitInput(request),
      max_concurrency: parseLimitInput(concurrency),
    },
  };
}

function CreateKeyForm({
  api,
  onDone,
  onCancel,
  onIssued,
}: {
  api: AdminApi;
  onDone: () => void;
  onCancel: () => void;
  onIssued: (plaintext: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const limits = useLimitInputs({ daily_token_limit: 0, daily_request_limit: 0, max_concurrency: 0 });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const created = await api.createAccessKey({ name, ...limits.parsed });
      onIssued(created.access_key);
      onDone();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  return (
    <form className="detail-fields" onSubmit={submit}>
      <label className="field-row">
        {t("myKeys.nameLabel")}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("myKeys.namePlaceholder")} required />
      </label>
      {limits.fields}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>{t("myKeys.cancel")}</button>
        <button type="submit" className="primary">{t("myKeys.createSubmit")}</button>
      </div>
    </form>
  );
}
