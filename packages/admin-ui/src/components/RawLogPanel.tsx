import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AccessKeyRow, AdminApi, Identity, LogRow, ProviderRow, UserRow } from "../lib/api";
import { effectiveWindow, filterLogs, loadTimeRangePref, saveTimeRangePref, type TimeRange } from "../lib/aggregate";
import type { LogStore } from "../lib/logstore";
import { exportCsv } from "../lib/csv";
import { useLogSync } from "../hooks/useLogSync";
import { keyDisplayName, deletedKeyName } from "./KeyTrendChart";
import { TimeRangeBar } from "./TimeRangeBar";
import { formatClock, formatLogTime } from "../lib/format";

/**
 * 原始日志面板（desktop 05；UI 2.0 #18 起为 split 布局，打磨轮 A 撤 aside 回归
 * 纯列表——表格列已承载概览信息，详情除报文外无料可展）：完整元数据行的分页
 * 浏览器（时间倒序）。筛选 = 仪表盘同款（时间窗/model/provider/user）+ 场景 key
 * 与状态码 + 仅失败开关与一键重置（时间窗除外）；状态码列 2xx/4xx/5xx 三级配色、
 * request_id 截断（全值走 title，行内复制按钮）。失败行（status ≥ 400 或有
 * error_type）可点开行内展开，显示错误类型与错误详情摘要（打磨轮 B 落库的
 * error_message，网关仍不落请求/回复报文体）。双入口复用本组件：管理面板全量；
 * 「我的」面板（selfOnly）钉定 identity.id，镜像混入他人行也只见自己。
 * 数据源 = LogStore（桌面 SQLite / Web Dexie）。
 */

const PAGE_SIZE = 50;

/** 我的入口身份缺失时的哨兵用户 id：不匹配任何行（空集），绝不放行全量。 */
const NO_SELF_USER = "__no_self__";

/** 状态码视觉分级：2xx 中性、4xx 警示、5xx 危险（.log-status 配色）。 */
function statusClass(status: number): string {
  if (status >= 500) return "err5";
  if (status >= 400) return "err4";
  return "ok";
}

/** request_id 截断显示：全值走 title，行内复制按钮取全值。 */
function shortRequestId(id: string): string {
  return id.length <= 20 ? id : `${id.slice(0, 14)}…${id.slice(-4)}`;
}

/** 失败行（可展开看错误详情）：≥400 或带错误类型（历史行可能只有后者）。 */
function isFailedRow(row: LogRow): boolean {
  return row.status >= 400 || row.error_type !== null;
}

export function RawLogPanel({
  api,
  db,
  identity,
  selfOnly = false,
}: {
  api: AdminApi;
  db: LogStore;
  /** 我的入口：行范围钉定该身份的 user_id。 */
  identity?: Identity;
  selfOnly?: boolean;
}) {
  const { t } = useTranslation();
  const sync = useLogSync(api, db);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [accessKeys, setAccessKeys] = useState<AccessKeyRow[]>([]);
  const [range, setRange] = useState<TimeRange>(() => loadTimeRangePref(window.localStorage));
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  /** 切档即记忆（跨会话）；custom 还原不了不落盘。 */
  const changeRange = (r: TimeRange) => {
    setRange(r);
    saveTimeRangePref(window.localStorage, r);
  };
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [user, setUser] = useState("");
  const [keyId, setKeyId] = useState("");
  const [status, setStatus] = useState("");
  /** 仅失败快捷开关：status ≥ 400 的行（排查主场景，免逐个挑状态码）。 */
  const [failedOnly, setFailedOnly] = useState(false);
  const [page, setPage] = useState(1);
  /** 行内展开的错误详情：展开行 id；null = 全部收起。 */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedReq, setCopiedReq] = useState<string | null>(null);

  // 本地镜像读取：ts 范围下推到 LogStore（spec desktop 03/05——模型/供应商/
  // key/状态等过滤留在纯函数层），窗口变化即重查。
  useEffect(() => {
    const { from, to } = effectiveWindow(range, customFrom, customTo, Date.now());
    db.listLogs(from, to).then(setLogs).catch(() => setLogs([]));
    api.listProviders().then(setProviders).catch(() => setProviders([]));
    api.listAccessKeys().then(setAccessKeys).catch(() => setAccessKeys([]));
    if (!selfOnly) api.listUsers().then(setUsers).catch(() => setUsers([]));
  }, [db, api, sync.lastSyncAt, selfOnly, range, customFrom, customTo]);

  const models = useMemo(() => [...new Set(logs.map((l) => l.client_model))].sort(), [logs]);
  // 状态码选项从镜像推导（命中过的才可选）。
  const statuses = useMemo(() => [...new Set(logs.map((l) => l.status))].sort((a, b) => a - b), [logs]);
  // 场景 key 选项 = 现存 key ∪ 日志行引用过的 key（key 可能已删，行仍在）。
  const keyOptions = useMemo(() => {
    const known = new Set(accessKeys.map((k) => k.id));
    const orphans = [...new Set(logs.map((l) => l.access_key_id).filter((id): id is string => id !== null && !known.has(id)))].sort();
    return [
      ...accessKeys.map((k) => ({ id: k.id, label: keyDisplayName(k) })),
      ...orphans.map((id) => ({ id, label: deletedKeyName(id) })),
    ];
  }, [accessKeys, logs]);

  const { from, to } = effectiveWindow(range, customFrom, customTo, Date.now());

  // 我的入口只看自己（user_id = identity.id）；身份缺失时宁可空集也不放行
  // 他人行（user story 16 的安全侧默认）。
  const selfFilterUser = selfOnly ? (identity?.id ?? NO_SELF_USER) : undefined;

  const visible = useMemo(() => {
    const filtered = filterLogs(logs, {
      from,
      to,
      model: model || undefined,
      provider: provider || undefined,
      user: selfFilterUser ?? (user || undefined),
      key: keyId || undefined,
      status: status === "" ? undefined : Number(status),
    });
    // 仅失败开关与状态码下拉可叠加（选 200 + 仅失败 = 空，语义诚实）。
    return filtered.filter((l) => !failedOnly || l.status >= 400).sort((a, b) => b.ts - a.ts); // 时间倒序
  }, [logs, from, to, model, provider, user, keyId, status, failedOnly, selfFilterUser]);

  // 筛选变化回到第一页；页码越界（行数缩水）时夹回末页。
  useEffect(() => {
    setPage(1);
  }, [range, customFrom, customTo, model, provider, user, keyId, status, failedOnly]);

  // 一键重置（时间窗除外）：有任一激活筛选时才出现。
  const hasFilters = failedOnly || model !== "" || provider !== "" || user !== "" || keyId !== "" || status !== "";
  const resetFilters = () => {
    setFailedOnly(false);
    setModel("");
    setProvider("");
    setUser("");
    setKeyId("");
    setStatus("");
  };
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  // 表列数（我的入口无「用户」列）——表头/空态/展开行的 colSpan 单一来源。
  const colCount = selfOnly ? 11 : 12;

  const providerName = (id: string | null) => (id === null ? "—" : providers.find((p) => p.id === id)?.name ?? id);
  const keyLabel = (id: string | null) => {
    if (id === null) return t("logs.noOwnerKey");
    const key = accessKeys.find((k) => k.id === id);
    return key === undefined ? deletedKeyName(id) : key.name;
  };
  const userName = (id: string | null) => (id === null ? "—" : users.find((u) => u.id === id)?.name ?? id);

  const onExport = () => {
    const prefix = selfOnly ? "lutragate-my-raw-logs" : "lutragate-raw-logs";
    void exportCsv(`${prefix}-${new Date().toISOString().slice(0, 10)}.csv`, visible);
  };

  const onCopyRequestId = async (requestId: string) => {
    try {
      await navigator.clipboard.writeText(requestId);
      setCopiedReq(requestId);
    } catch {
      // 剪贴板不可用（权限/非安全上下文）——保持按钮原样，不视为面板错误。
    }
  };

  return (
    <section>
      <div className="panel-head">
        <h2>{selfOnly ? t("logs.myTitle") : t("logs.title")}</h2>
        <div className="sync-status">
          {sync.error && <span className="error" role="alert">{t("logs.syncFailed", { message: sync.error })}</span>}
          {sync.lastResult?.truncated && <span className="hint">{t("logs.syncTruncated")}</span>}
          {sync.lastSyncAt && !sync.error && (
            <span className="hint">
              {t("logs.lastSync", { time: formatClock(sync.lastSyncAt) })}
              {sync.lastResult ? t("logs.lastSyncInserted", { n: sync.lastResult.inserted }) : ""}
            </span>
          )}
          <button onClick={onExport}>{t("logs.exportCsv")}</button>
          <button onClick={sync.syncNow} disabled={sync.busy}>
            {sync.busy ? t("logs.syncing") : t("logs.syncNow")}
          </button>
        </div>
      </div>
      {/* 说明行占位（nbsp 保行高）：标题区高度与其他面板节奏一致。 */}
      <p className="hint">&nbsp;</p>

      <div className="filters">
        <TimeRangeBar
          range={range}
          customFrom={customFrom}
          customTo={customTo}
          onRangeChange={changeRange}
          onCustomChange={(f, t2) => {
            setCustomFrom(f);
            setCustomTo(t2);
          }}
        />
        <select value={model} onChange={(e) => setModel(e.target.value)} aria-label={t("logs.filterModel")}>
          <option value="">{t("logs.allModels")}</option>
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label={t("logs.filterProvider")}>
          <option value="">{t("logs.allProviders")}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {!selfOnly && (
          <select value={user} onChange={(e) => setUser(e.target.value)} aria-label={t("logs.filterUser")}>
            <option value="">{t("logs.allUsers")}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </select>
        )}
        <select value={keyId} onChange={(e) => setKeyId(e.target.value)} aria-label={t("logs.filterKey")}>
          <option value="">{t("logs.allKeys")}</option>
          {keyOptions.map((k) => (
            <option key={k.id} value={k.id}>{k.label}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t("logs.filterStatus")}>
          <option value="">{t("logs.allStatuses")}</option>
          {statuses.map((s) => (
            <option key={s} value={String(s)}>{s}</option>
          ))}
        </select>
        <button
          type="button"
          className={failedOnly ? "tab active" : "tab"}
          aria-pressed={failedOnly}
          onClick={() => setFailedOnly((v) => !v)}
        >
          {t("logs.failedOnly")}
        </button>
        {hasFilters && <button type="button" onClick={resetFilters}>{t("logs.resetFilters")}</button>}
      </div>

      <div className="table-scroll">
        <table className="log-table">
          <thead>
            <tr>
              <th>{t("logs.colTime")}</th><th>{t("logs.colRequest")}</th><th>{t("logs.colStatus")}</th><th>{t("logs.colModel")}</th><th>{t("logs.colProvider")}</th>
              {!selfOnly && <th>{t("logs.colUser")}</th>}
              <th>{t("logs.colKey")}</th><th>{t("logs.colPrompt")}</th><th>{t("logs.colCached")}</th><th>{t("logs.colCompletion")}</th><th>{t("logs.colLatency")}</th><th>{t("logs.colError")}</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const expandable = isFailedRow(row);
              const expanded = expandedId === row.id;
              return (
                <Fragment key={row.id}>
                  <tr
                    data-testid="log-row"
                    data-id={row.id}
                    {...(expandable ? { tabIndex: 0, "aria-expanded": expanded } : {})}
                    className={`log-row ${expandable ? "expandable" : ""}`}
                    onClick={expandable ? () => setExpandedId(expanded ? null : row.id) : undefined}
                    // 键盘可达（tabIndex 配套）：Enter/Space = 展开/收起错误详情。
                    onKeyDown={expandable
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setExpandedId(expanded ? null : row.id);
                          }
                        }
                      : undefined}
                  >
                    <td>{formatLogTime(row.ts)}</td>
                    <td className="mono req-cell" title={row.request_id}>
                      <span>{shortRequestId(row.request_id)}</span>
                      <button
                        type="button"
                        className="req-copy"
                        aria-label={`${t("logs.copy")} ${row.request_id}`}
                        onClick={(e) => {
                          e.stopPropagation(); // 不触发行展开
                          void onCopyRequestId(row.request_id);
                        }}
                      >
                        {copiedReq === row.request_id ? t("logs.copied") : t("logs.copy")}
                      </button>
                    </td>
                    <td><span className={`log-status ${statusClass(row.status)}`}>{row.status}</span></td>
                    <td className="mono">{row.client_model}{row.upstream_model !== null ? ` → ${row.upstream_model}` : ""}</td>
                    <td>{providerName(row.provider_id)}</td>
                    {!selfOnly && <td>{userName(row.user_id)}</td>}
                    <td>{keyLabel(row.access_key_id)}</td>
                    <td>{row.prompt_tokens ?? "—"}</td>
                    <td>{row.cached_tokens ?? "—"}</td>
                    <td>{row.completion_tokens ?? "—"}</td>
                    <td>{row.latency_ms === null ? "—" : `${row.latency_ms} ms`}</td>
                    <td>{row.error_type ?? "—"}</td>
                  </tr>
                  {expanded && (
                    <tr className="log-expand" data-testid="log-expand">
                      <td colSpan={colCount}>
                        <div className="log-expand-inner">
                          <span className="log-status err">{row.error_type ?? `HTTP ${row.status}`}</span>
                          {row.error_message
                            ? <pre className="error-pre">{row.error_message}</pre>
                            : <span className="hint">{t("logs.noErrorDetail")}</span>}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={colCount} className="empty">
                  {/* 两态空态（KeysPanel 先例）：时间窗内无数据 vs 有数据被筛掉。 */}
                  {logs.length === 0 ? t("logs.emptyList") : t("logs.emptyFiltered")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <button onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1}>{t("logs.pagerPrev")}</button>
        <span>{t("logs.pagerStatus", { page: currentPage, pages: pageCount, total: visible.length })}</span>
        <button onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount}>{t("logs.pagerNext")}</button>
      </div>
    </section>
  );
}
