import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PROVIDER_USAGE_TYPES } from "@lutragate/core";
import type { AccessKeyRow, AdminApi, GrantRow, Identity, LogRow, UsageRow } from "../lib/api";
import { effectiveWindow, filterLogs, isSuccessful, type TimeRange } from "../lib/aggregate";
import type { LogStore } from "../lib/logstore";
import { exportCsv } from "../lib/csv";
import { formatRemaining, indexUsageByKey, localMidnight, remaining, usageTokens } from "../lib/quota";
import { formatClock } from "../lib/format";
import { toErrorMessage } from "../lib/error";
import { credentialStatus, formatLastUsed } from "../lib/access-control";
import { lastRequestWithin24h, supportsUsage } from "../lib/status-aggregate";
import { useLogSync } from "../hooks/useLogSync";
import { KeyTrendChart } from "./KeyTrendChart";
import { KeyUsageCell } from "./KeyUsageCell";
import { QuotaUsage } from "./MyKeysPanel";
import { StatusBadge } from "./StatusBadge";
import { TimeRangeBar } from "./TimeRangeBar";

/**
 * 我的仪表盘（multi-user，user 视图；管理员亦可用）：个人用量总览——统计
 * 卡 + 按访问 key（=场景）/ 按模型两张分组表。数据全部来自 /admin/usage
 * （user 角色服务端 SQL 强制只回自己的行；administrator 传 user_id 钉定
 * 自己）；key 名与聚合行在客户端联表。按 key 表附「今日余量」列（quota：
 * 当日聚合 vs key 限额，0 = 不限）。desktop 04 增强三件套（自定义时间窗、
 * 按场景趋势、CSV 导出）走本地镜像（LogStore；user 角色同步自范围日志行，
 * /admin/logs SQL 钉定自己的行）。统计卡与分组表跟随时间窗口径（与趋势一致）。
 */
export function MyDashboardPanel({ api, db, identity }: { api: AdminApi; db: LogStore; identity?: Identity }) {
  const { t } = useTranslation();
  const sync = useLogSync(api, db);
  const [total, setTotal] = useState<UsageRow | null>(null);
  const [byKey, setByKey] = useState<UsageRow[]>([]);
  const [byModel, setByModel] = useState<UsageRow[]>([]);
  const [keys, setKeys] = useState<AccessKeyRow[]>([]);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [todayBy, setTodayBy] = useState<Map<string, UsageRow>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [range, setRange] = useState<TimeRange>("7d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  // administrator 的自助视图钉在自己的 user 上（服务端对 admin 返回全局）。
  const selfUserId = identity?.role === "administrator" ? identity.id : null;

  const refresh = useCallback(async () => {
    try {
      const scope = selfUserId ? { user_id: selfUserId } : {};
      // 聚合口径跟随时间窗（与趋势图/导出一致；「全部」档不传 from/to）。
      // 当日窗口仅用于余量列，恒为本地午夜起。
      const { from, to } = effectiveWindow(range, customFrom, customTo, Date.now());
      const [ungrouped, keyRows, modelRows, accessKeys, todayRows] = await Promise.all([
        api.getUsage({ ...scope, from, to }),
        api.getUsage({ group_by: "key", ...scope, from, to }),
        api.getUsage({ group_by: "model", ...scope, from, to }),
        api.listAccessKeys(),
        // 余量列的「已用」取当日（本地午夜起）聚合。
        api.getUsage({ group_by: "key", from: localMidnight(), ...scope }),
      ]);
      setTotal(ungrouped.usage[0] ?? null);
      setByKey(keyRows.usage);
      setByModel(modelRows.usage);
      setKeys(selfUserId ? accessKeys.filter((k) => k.user_id === selfUserId) : accessKeys);
      setTodayBy(indexUsageByKey(todayRows.usage));
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  // lastSyncAt 入 deps（code-review P4）：「立即同步」后今日余量/统计卡重拉。
  }, [api, selfUserId, range, customFrom, customTo, sync.lastSyncAt]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 上游套餐卡段（dash-status 02）：me/grants 随 refresh 重拉；失败静默降级
  //（CF Access 虚拟管理员无 user_id 会 400——该形态下本就不展示上游段）。
  useEffect(() => {
    let cancelled = false;
    api
      .getMyGrants()
      .then((r) => { if (!cancelled) setGrants(r.grants ?? []); })
      .catch(() => { if (!cancelled) setGrants([]); });
    return () => { cancelled = true; };
  }, [api, sync.lastSyncAt]);

  // 本地镜像（desktop 04）：同步完成后读取；趋势与导出以此为源。
  // 卸载后不再 setState（测试 teardown 后异步返回会触发 unhandled rejection）。
  useEffect(() => {
    let cancelled = false;
    db.listLogs()
      .then((rows) => { if (!cancelled) setLogs(rows); })
      .catch(() => { if (!cancelled) setLogs([]); });
    return () => { cancelled = true; };
  }, [db, sync.lastSyncAt]);

  // 生效窗口（规则见 aggregate.effectiveWindow；两块仪表盘共用）；user 维度
  // 钉定自己（镜像混入他人行时也只看自己的）。
  const { from, to } = effectiveWindow(range, customFrom, customTo, Date.now());
  const visible = useMemo(
    () => filterLogs(logs, { from, to, user: identity?.id ?? undefined }),
    [logs, from, to, identity?.id],
  );
  // 状态卡的「最近请求」（24h 窗内最近一条，dash-status 02）；镜像已按身份同步。
  const lastBy = useMemo(() => lastRequestWithin24h(logs, Date.now()), [logs]);

  const onExport = () => {
    void exportCsv(`lutragate-my-logs-${new Date().toISOString().slice(0, 10)}.csv`, visible);
  };

  const keyLabel = (id: string | null | undefined) => {
    if (id === null || id === undefined) return "历史（无归属）";
    const key = keys.find((k) => k.id === id);
    // key 被吊销后日志行仍带 id——给出可读回退而非裸 UUID。
    return key === undefined ? `已删除的 key（${id.slice(0, 8)}…）` : `${key.name}（****${key.key_hint}）`;
  };

  /** 今日余量（请求 / Tokens）：限额来自 key 列表；0 或已删 key → 不限。 */
  const todayRemaining = (id: string | null | undefined) => {
    const key = id === null || id === undefined ? undefined : keys.find((k) => k.id === id);
    if (key === undefined) return "不限";
    const usage = id === null || id === undefined ? undefined : todayBy.get(id);
    const restReq = remaining(usage?.requests ?? 0, key.daily_request_limit);
    const restTok = remaining(usageTokens(usage), key.daily_token_limit);
    if (restReq === null && restTok === null) return "不限";
    return `请求 ${formatRemaining(restReq)} / Tokens ${formatRemaining(restTok)}`;
  };

  return (
    <section>
      <div className="panel-head">
        <h2>我的仪表盘</h2>
        <div className="sync-status">
          {sync.error && <span className="error" role="alert">同步失败：{sync.error}</span>}
          {sync.lastResult?.truncated && <span className="hint">同步已达单次上限，历史积压将在下次同步续拉</span>}
          {sync.lastSyncAt && !sync.error && (
            <span className="hint">
              上次同步 {formatClock(sync.lastSyncAt)}
              {sync.lastResult ? `（新增 ${sync.lastResult.inserted} 条）` : ""}
            </span>
          )}
          <button onClick={onExport}>导出 CSV</button>
          <button onClick={sync.syncNow} disabled={sync.busy}>
            {sync.busy ? "同步中…" : "立即同步"}
          </button>
        </div>
      </div>
      <p className="hint">仅统计自己的请求；按 key（=场景）与模型分组。</p>
      {error && <p className="error" role="alert">{error}</p>}

      {/* 当前状态（dash-status 02）：不随时间窗变化；紧凑行布局（dash-redesign 01，
          适配首屏一屏目标）；其下统计卡/图表归历史统计段。 */}
      <h3 className="section-title">{t("dashStatus.title")}</h3>
      {keys.length === 0 ? (
        <p className="empty">{t("dashStatus.noKeys")}</p>
      ) : (
        <div className="status-list">
          {keys.map((k) => {
            const last = lastBy.get(k.id);
            // 个人视角登录即本人启用，owner_disabled 不可达——credentialStatus
            // 不传 ownerEnabled 是明示降级（该态只可能出现在管理员代管视图）。
            const ok = last !== undefined && isSuccessful(last);
            return (
              <div className="status-row" key={k.id}>
                <span className="status-name">{k.name}（****{k.key_hint}）</span>
                <StatusBadge status={credentialStatus({ enabled: k.enabled, expires_at: k.expires_at })} />
                <QuotaUsage usage={todayBy.get(k.id)} row={k} />
                <span className={last === undefined ? "status-last muted" : ok ? "status-last ok" : "status-last fail"}>
                  {last === undefined
                    ? t("dashStatus.lastRequestIdle")
                    : ok
                      ? t("dashStatus.lastRequestOk", { time: formatLastUsed(last.ts) })
                      : t("dashStatus.lastRequestFail", { time: formatLastUsed(last.ts) })}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {/* 上游套餐行段：只出支持用量查询的类型（grill 拍板「不支持类型不出卡」，
          与 KeyUsageCell 的格级隐藏双保险；缺管控面凭证的 key 仍出行，行内
          呈现引导态——个人视角无从预判凭证是否在，取回响应才可知）。 */}
      {grants.some(supportsUsage) && (
        <>
          <h3 className="section-title">{t("dashStatus.upstreamTitle")}</h3>
          <div className="status-list">
            {grants.filter(supportsUsage).map((g) => (
              <div className="status-row" key={g.id}>
                <span className="status-name">{g.provider_name}（****{g.key_hint}）</span>
                <KeyUsageCell api={api} keyRow={{ id: g.provider_key_id }} providerType={g.provider_type} />
              </div>
            ))}
          </div>
        </>
      )}

      <h3 className="section-title">{t("dashStatus.history")}</h3>
      <div className="filters">
        <TimeRangeBar
          range={range}
          customFrom={customFrom}
          customTo={customTo}
          onRangeChange={setRange}
          onCustomChange={(f, t) => {
            setCustomFrom(f);
            setCustomTo(t);
          }}
        />
      </div>

      <div className="chart">
        <h3>按场景趋势</h3>
        <KeyTrendChart logs={visible} keys={keys} from={from} to={to} />
      </div>

      <div className="stat-cards">
        <StatCard label="请求量" value={String(total?.requests ?? 0)} sub={`错误 ${total?.errors ?? 0}`} />
        <StatCard
          label="成功率"
          value={
            total === null || total.requests === 0
              ? "—"
              : `${(((total.requests - total.errors) / total.requests) * 100).toFixed(1)}%`
          }
        />
        <StatCard label="Prompt Tokens" value={(total?.prompt_tokens ?? 0).toLocaleString()} />
        <StatCard label="Completion Tokens" value={(total?.completion_tokens ?? 0).toLocaleString()} />
      </div>

      <div className="chart">
        <h3>按访问 Key</h3>
        <table>
          <thead>
            <tr>
              <th>Key</th><th>请求数</th><th>错误数</th><th>Prompt</th><th>Completion</th><th>平均延迟 (ms)</th><th>今日余量</th>
            </tr>
          </thead>
          <tbody>
            {byKey.map((r, i) => (
              <tr key={r.access_key_id ?? `legacy-${i}`}>
                <td>{keyLabel(r.access_key_id)}</td>
                <td>{r.requests}</td>
                <td>{r.errors}</td>
                <td>{r.prompt_tokens}</td>
                <td>{r.completion_tokens}</td>
                <td>{r.avg_latency_ms}</td>
                <td>{todayRemaining(r.access_key_id)}</td>
              </tr>
            ))}
            {byKey.length === 0 && (
              <tr><td colSpan={7} className="empty">还没有用量数据。</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="chart">
        <h3>按模型</h3>
        <table>
          <thead>
            <tr><th>模型</th><th>请求数</th><th>错误数</th><th>Prompt</th><th>Completion</th></tr>
          </thead>
          <tbody>
            {byModel.map((r, i) => (
              <tr key={r.client_model ?? `legacy-${i}`}>
                <td className="mono">{r.client_model ?? "（未知）"}</td>
                <td>{r.requests}</td>
                <td>{r.errors}</td>
                <td>{r.prompt_tokens}</td>
                <td>{r.completion_tokens}</td>
              </tr>
            ))}
            {byModel.length === 0 && (
              <tr><td colSpan={5} className="empty">还没有用量数据。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
