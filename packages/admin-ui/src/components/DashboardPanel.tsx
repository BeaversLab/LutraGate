import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatClock } from "../lib/format";
import type { AccessKeyRow, AdminApi, KeyRow, LogRow, ProviderRow, UserRow } from "../lib/api";
import {
  aggregateLogs,
  effectiveWindow,
  filterLogs,
  NO_PROVIDER_KEY,
  NO_USER_KEY,
  type TimeRange,
} from "../lib/aggregate";
import type { LogStore } from "../lib/logstore";
import { exportCsv } from "../lib/csv";
import { adminStatusTriggers, hourStatsByProvider, type AdminStatusTrigger } from "../lib/status-aggregate";
import { useLogSync } from "../hooks/useLogSync";
import { ChartCard, LegendChip } from "./charts/ChartCard";
import { StackedBar } from "./charts/StackedBar";
import { KeyTrendChart } from "./KeyTrendChart";
import { TimeRangeBar } from "./TimeRangeBar";

/** 管理仪表盘（PRD F4.4/F6.3/F6.4 + desktop 04 增强）：本地镜像聚合，不走
 * 网关；含按用户的维度统计与筛选（多用户）、自定义时间窗、按场景趋势对比
 * 与 CSV 导出。用户个人视图见 MyDashboardPanel。 */
export function DashboardPanel({ api, db, onViewLogs }: { api: AdminApi; db: LogStore; onViewLogs?: () => void }) {
  const { t } = useTranslation();
  const sync = useLogSync(api, db);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [accessKeys, setAccessKeys] = useState<AccessKeyRow[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [range, setRange] = useState<TimeRange>("7d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [model, setModel] = useState<string>("");
  const [provider, setProvider] = useState<string>("");
  const [user, setUser] = useState<string>("");

  // 同步完成后（以及筛选变化时）从本地镜像读取。
  useEffect(() => {
    db.listLogs().then(setLogs).catch(() => setLogs([]));
    api.listProviders().then(setProviders).catch(() => setProviders([]));
    api.listUsers().then(setUsers).catch(() => setUsers([]));
    api.listAccessKeys().then(setAccessKeys).catch(() => setAccessKeys([]));
    // 状态区（dash-status 03）：上游 key 冷却态。
    api.listKeys().then(setKeys).catch(() => setKeys([]));
  }, [db, api, sync.lastSyncAt]);

  const models = useMemo(
    () => [...new Set(logs.map((l) => l.client_model))].sort(),
    [logs],
  );
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  const userName = (id: string) => users.find((u) => u.id === id)?.name ?? id;

  // 生效窗口（规则见 aggregate.effectiveWindow；两块仪表盘共用）。
  const { from, to, bucketMs } = effectiveWindow(range, customFrom, customTo, Date.now());

  const visible = useMemo(
    () =>
      filterLogs(logs, {
        from,
        to,
        model: model || undefined,
        provider: provider || undefined,
        user: user || undefined,
      }),
    [logs, from, to, model, provider, user],
  );
  const agg = useMemo(() => aggregateLogs(visible, bucketMs), [visible, bucketMs]);

  // 当前状态区（dash-status 03）：不随时间窗；近 1h 镜像聚合 + key 冷却态。
  // now 锚定数据变化（deps 与 memo 对齐），避免 render 体 Date.now() 使 memo 恒失效。
  const now = useMemo(() => Date.now(), [logs, keys, providers]);
  const triggers = useMemo(
    () => adminStatusTriggers(logs, keys, providers, now),
    [logs, keys, providers, now],
  );
  const hourBy = useMemo(() => hourStatsByProvider(logs, now), [logs, now]);
  const triggerText = (tr: AdminStatusTrigger) =>
    tr.kind === "cooldown"
      ? t("dashAdmin.triggerCooldown", { name: tr.providerName })
      : tr.kind === "failure_rate"
        ? t("dashAdmin.triggerFailureRate", { name: tr.providerName, failures: tr.failures, requests: tr.requests })
        : t("dashAdmin.triggerNoChannel");

  const onExport = () => {
    void exportCsv(`lutragate-logs-${new Date().toISOString().slice(0, 10)}.csv`, visible);
  };

  return (
    <section>
      <div className="panel-head">
        <h2>管理仪表盘</h2>
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

      {/* 当前状态（dash-status 03）：警示条三触发器 + 供应商健康卡；不随时间窗。 */}
      <h3 className="section-title">{t("dashStatus.title")}</h3>
      {triggers.length > 0 && (
        <button type="button" className="status-alert" onClick={onViewLogs}>
          {t("dashAdmin.warning", { reasons: triggers.map(triggerText).join(t("dashAdmin.separator")) })}
        </button>
      )}
      <h4 className="status-subtitle">{t("dashAdmin.providersTitle")}</h4>
      {providers.length === 0 ? (
        <p className="empty">{t("dashAdmin.noProviders")}</p>
      ) : (
        <div className="status-list">
          {providers.map((p) => {
            const stat = hourBy.get(p.id) ?? { requests: 0, failures: 0 };
            const coolingUntil = Math.max(0, ...keys.filter((k) => k.provider_id === p.id).map((k) => k.cooldown_until));
            return (
              <div className="status-row" key={p.id}>
                <span className="status-name">{p.name}</span>
                <span className={p.enabled ? "badge on" : "badge off"}>
                  {p.enabled ? t("providers.enabled") : t("providers.disabled")}
                </span>
                <span className="status-meta">
                  {t("providers.weight", { weight: p.weight })}
                  {coolingUntil > now
                    ? ` · ${t("providers.health.cooldownUntil", { time: formatClock(coolingUntil) })}`
                    : ""}
                </span>
                <span className={stat.requests === 0 ? "status-last muted" : "status-last"}>
                  {stat.requests === 0
                    ? t("dashAdmin.hourIdle")
                    : t("dashAdmin.hourStat", { requests: stat.requests, failures: stat.failures })}
                </span>
              </div>
            );
          })}
        </div>
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
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">全部模型</option>
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="">全部供应商</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select value={user} onChange={(e) => setUser(e.target.value)} aria-label="用户">
          <option value="">全部用户</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
      </div>

      <div className="stat-cards">
        <StatCard label="请求量" value={String(agg.totalRequests)} sub={`失败 ${agg.failedRequests}`} />
        <StatCard
          label="成功率"
          value={agg.successRate === null ? "—" : `${(agg.successRate * 100).toFixed(1)}%`}
        />
        <StatCard label="Prompt Tokens" value={agg.promptTokens.toLocaleString()} />
        <StatCard label="Completion Tokens" value={agg.completionTokens.toLocaleString()} />
      </div>

      {/* 请求量时间线（dash-redesign 02）：堆叠柱原语——成功/失败双色 + 日期轴 + hover。 */}
      <ChartCard
        title={t("dashCharts.timelineTitle")}
        legend={
          <>
            <LegendChip color="var(--primary)" label={t("dashCharts.ok")} />
            <LegendChip color="var(--danger)" label={t("dashCharts.failed")} />
          </>
        }
      >
        {agg.timeline.length === 0 ? (
          <p className="empty">所选范围内暂无请求。</p>
        ) : (
          <StackedBar
            data={agg.timeline.map((b) => ({ start: b.start, ok: b.requests - b.failed, failed: b.failed }))}
            bucketMs={bucketMs}
            formatTooltip={({ date, total, failed }) =>
              failed > 0
                ? t("dashCharts.tipWithFailures", { date, total, failed })
                : t("dashCharts.tipNoFailures", { date, total })
            }
          />
        )}
      </ChartCard>

      {/* 按场景（key）趋势对比：管理盘跨用户全部 key（desktop 04）。 */}
      <Chart title="按场景趋势">
        <KeyTrendChart logs={visible} keys={accessKeys} from={from} to={to} />
      </Chart>

      <div className="charts-row">
        <Chart title="各供应商延迟分布">
          {agg.byProvider.length === 0 ? (
            <p className="empty">暂无数据。</p>
          ) : (
            <table>
              <thead>
                <tr><th>供应商</th><th>请求</th><th>失败</th><th>平均</th><th>P50</th><th>P95</th><th>P99</th></tr>
              </thead>
              <tbody>
                {agg.byProvider.map((p) => (
                  <tr key={p.provider}>
                    <td>{p.provider === NO_PROVIDER_KEY ? NO_PROVIDER_KEY : providerName(p.provider)}</td>
                    <td>{p.requests}</td>
                    <td>{p.errors}</td>
                    <td>{p.avgLatencyMs === null ? "—" : `${p.avgLatencyMs} ms`}</td>
                    <td>{p.p50LatencyMs === null ? "—" : `${p.p50LatencyMs} ms`}</td>
                    <td>{p.p95LatencyMs === null ? "—" : `${p.p95LatencyMs} ms`}</td>
                    <td>{p.p99LatencyMs === null ? "—" : `${p.p99LatencyMs} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Chart>

        <Chart title="延迟分布">
          <div className="bars horizontal">
            {agg.latencyBuckets.map((b) => (
              <div key={b.label} className="hbar-row">
                <span className="hbar-label">{b.label}</span>
                <div
                  className="hbar"
                  style={{ width: `${(b.count / Math.max(...agg.latencyBuckets.map((x) => x.count), 1)) * 100}%` }}
                />
                <span className="bar-label">{b.count}</span>
              </div>
            ))}
          </div>
        </Chart>
      </div>

      <Chart title="用户用量">
        {agg.byUser.length === 0 ? (
          <p className="empty">暂无数据。</p>
        ) : (
          <table>
            <thead>
              <tr><th>用户</th><th>请求</th><th>失败</th><th>Prompt</th><th>Completion</th></tr>
            </thead>
            <tbody>
              {agg.byUser.map((u) => (
                <tr key={u.user}>
                  <td>{u.user === NO_USER_KEY ? NO_USER_KEY : userName(u.user)}</td>
                  <td>{u.requests}</td>
                  <td>{u.errors}</td>
                  <td>{u.promptTokens.toLocaleString()}</td>
                  <td>{u.completionTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Chart>

      <Chart title="模型用量">
        {agg.byModel.length === 0 ? (
          <p className="empty">暂无数据。</p>
        ) : (
          <table>
            <thead>
              <tr><th>模型</th><th>请求</th><th>Prompt</th><th>Completion</th></tr>
            </thead>
            <tbody>
              {agg.byModel.map((m) => (
                <tr key={m.model}>
                  <td className="mono">{m.model}</td>
                  <td>{m.requests}</td>
                  <td>{m.promptTokens.toLocaleString()}</td>
                  <td>{m.completionTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Chart>
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

function Chart({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="chart">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
