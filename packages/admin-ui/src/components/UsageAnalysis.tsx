import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AccessKeyRow, AdminApi, LogRow, ProviderRow, UserRow, Identity } from "../lib/api";
import { loadAnalysisSource } from "../lib/analysis-source";
import type { LogStore } from "../lib/logstore";
import { aggregateLogs, effectiveWindow, filterLogs, isSuccessful, loadTimeRangePref, saveTimeRangePref, type TimeRange } from "../lib/aggregate";
import { useLogSync } from "../hooks/useLogSync";
import { formatDateTime } from "../lib/format";
import { exportCsv } from "../lib/csv";
import { KeyTrendChart } from "./KeyTrendChart";
import { TimeRangeBar } from "./TimeRangeBar";
import "./usage-analysis.css";

export interface UsageAnalysisContext { from: number; to: number; key?: string; provider?: string; failedOnly?: boolean; unforwardedOnly?: boolean }
type AnalysisTab = "model" | "user" | "scene" | "latency";
const fmt = (n: number) => n.toLocaleString();
export function UsageAnalysis({ api, db, context, onBack, identity }: { identity?: Identity; api: AdminApi; db: LogStore; context?: UsageAnalysisContext; onBack: () => void }) {
  const { t } = useTranslation();
  const sync = useLogSync(api, db);
  const personal = identity !== undefined;
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [keys, setKeys] = useState<AccessKeyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<AnalysisTab>("model");
  const [range, setRange] = useState<TimeRange>(() => loadTimeRangePref(window.localStorage));
  /** 切档即记忆（跨会话）；custom 还原不了不落盘。 */
  const changeRange = (r: TimeRange) => {
    setRange(r);
    saveTimeRangePref(window.localStorage, r);
  };
  const [inherited, setInherited] = useState(context);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState(context?.provider ?? "");
  const [user, setUser] = useState("");
  const [key, setKey] = useState(context?.key ?? "");
  const [outcome, setOutcome] = useState(context?.unforwardedOnly ? "unforwarded" : context?.failedOnly ? "failed" : "all");
  const [metric, setMetric] = useState<"tokens" | "requests">("tokens");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadAnalysisSource(api, db, identity).then(({ logs: l, providers: p, users: u, keys: k }) => {
      if (cancelled) return;
      setLogs(l); setProviders(p); setUsers(u); setKeys(k); setError(null); setNow(Date.now());
    }).catch(e => { if (!cancelled) setError(String(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, db, sync.lastSyncAt, identity?.id]);
  const win = inherited ? { from: inherited.from, to: inherited.to, bucketMs: 86_400_000 } : effectiveWindow(range, customFrom, customTo, now);
  const visible = useMemo(() => filterLogs(logs, { from: win.from, to: win.to, model: model || undefined, provider: provider || undefined, user: user || undefined, key: key && key !== "__unknown" ? key : undefined }).filter(l => key !== "__unknown" || l.access_key_id === null).filter(l => outcome === "failed" ? !isSuccessful(l) : outcome === "unforwarded" ? l.provider_id === null : true), [logs, win.from, win.to, model, provider, user, key, outcome]);
  const agg = useMemo(() => aggregateLogs(visible, win.bucketMs), [visible, win.bucketMs]);
  const nameOf = (id: string | null, rows: { id: string; name: string }[], fallback: string) => rows.find(r => r.id === id)?.name ?? fallback;
  const ranks = tab === "user" ? agg.byUser.map(u => ({ id: u.user, name: nameOf(u.user, users, t("analysis.unownedUser")), errors: u.errors, requests: u.requests, input: u.promptTokens, output: u.completionTokens })) : agg.byModel.map(m => ({ id: m.model, name: m.model, errors: visible.filter(l => l.client_model === m.model && !isSuccessful(l)).length, requests: m.requests, input: m.promptTokens, output: m.completionTokens }));
  const sorted = [...ranks].sort((a, b) => metric === "tokens" ? b.input + b.output - a.input - a.output : b.requests - a.requests);
  const maximum = Math.max(1, ...sorted.map(r => metric === "tokens" ? r.input + r.output : r.requests));
  const models = [...new Set(logs.map(l => l.client_model))].sort();
  const unknown = visible.filter(l => l.prompt_tokens === null || l.completion_tokens === null).length;
  return <section className="usage-analysis">
    <header className="ua-heading"><div><button onClick={onBack}>{t("analysis.back")}</button><h2>{personal ? t("analysis.myTitle") : t("analysis.title")}</h2></div><div><button disabled={sync.busy} onClick={sync.syncNow}>{sync.busy ? t("logs.syncing") : t("logs.syncNow")}</button><button disabled={!visible.length} onClick={() => { void exportCsv(personal ? "lutragate-my-usage.csv" : "lutragate-usage.csv", personal ? visible.map(l => ({ ...l, provider_id: null, key_id: null })) : visible).catch(e => setError(String(e))); }}>{t("analysis.exportCsv")}</button></div></header>
    {(error || sync.error) && <p className="error" role="alert">{error ?? sync.error}</p>}
    {loading && <p role="status">{t("analysis.loading")}</p>}
    {sync.lastResult?.truncated && <p className="hint">{t("logs.syncTruncated")}</p>}
    <div className="ua-time">{inherited ? <><span>{t("analysis.inheritedFrom")}{formatDateTime(inherited.from)} — {formatDateTime(inherited.to)}</span><button onClick={() => setInherited(undefined)}>{t("analysis.pickRange")}</button></> : <TimeRangeBar range={range} customFrom={customFrom} customTo={customTo} onRangeChange={changeRange} onCustomChange={(f, t2) => { setCustomFrom(f); setCustomTo(t2); }} />}</div>
    <div className="ua-filters"><select aria-label={t("analysis.filterModelAria")} value={model} onChange={e => setModel(e.target.value)}><option value="">{t("analysis.allModels")}</option>{models.map(m => <option key={m}>{m}</option>)}</select><select aria-label={personal ? t("analysis.filterModelProviderAria") : t("analysis.filterProviderAria")} value={provider} onChange={e => setProvider(e.target.value)}><option value="">{personal ? t("analysis.allModelsUpstream") : t("analysis.allProviders")}</option>{providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}{provider && !providers.some(p => p.id === provider) && <option value={provider}>{personal ? t("analysis.historicalModel") : t("analysis.deletedProvider")}</option>}</select>{!personal && <select aria-label={t("analysis.filterUserAria")} value={user} onChange={e => setUser(e.target.value)}><option value="">{t("analysis.allUsers")}</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}<select aria-label={t("analysis.filterSceneAria")} value={key} onChange={e => setKey(e.target.value)}><option value="">{t("analysis.allScenes")}</option>{keys.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}{key && !keys.some(k => k.id === key) && <option value={key}>{key === "__unknown" ? t("analysis.unowned") : t("analysis.deletedKey")}</option>}</select><select aria-label={t("analysis.filterResultAria")} value={outcome} onChange={e => setOutcome(e.target.value)}><option value="all">{t("analysis.resultAll")}</option><option value="failed">{t("analysis.resultFailed")}</option><option value="unforwarded">{t("analysis.resultUnforwarded")}</option></select><button onClick={() => { setModel(""); setProvider(""); setUser(""); setKey(""); setOutcome("all"); }}>{t("analysis.clearFilters")}</button></div>
    <div className="ua-summary">{[[t("analysis.summaryRequests"), fmt(agg.totalRequests)], [t("analysis.summarySuccessRate"), agg.successRate === null ? "—" : `${(agg.successRate * 100).toFixed(1)}%`], [t("analysis.summaryFailed"), fmt(agg.failedRequests)], [t("analysis.summaryPrompt"), fmt(agg.promptTokens)], [t("analysis.summaryCompletion"), fmt(agg.completionTokens)]].map(([label, value]) => <span key={label}>{label}<strong>{value}</strong></span>)}</div>
    <div className="ua-tabs" role="group" aria-label={t("analysis.tabsAria")}>{([["model", t("analysis.tabModel")], ["user", t("analysis.tabUser")], ["scene", t("analysis.tabScene")], ["latency", t("analysis.tabLatency")]] as const).filter(([id]) => !personal || id !== "user").map(([id, name]) => <button key={id} aria-pressed={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{name}</button>)}</div>
    {!visible.length ? <p className="empty">{t("analysis.empty")}</p> : <>
      {(tab === "model" || tab === "user") && <><div className="ua-chart-heading"><h3>{tab === "model" ? t("analysis.rankModelTitle") : t("analysis.rankUserTitle")}</h3><div><button aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>{t("analysis.metricTokens")}</button><button aria-pressed={metric === "requests"} onClick={() => setMetric("requests")}>{t("analysis.metricRequests")}</button></div></div><div className="ua-ranking">{sorted.slice(0, 10).map(r => { const value = metric === "tokens" ? r.input + r.output : r.requests; return <div key={r.id}><span title={r.name}>{r.name}</span><div className="ua-rank-track"><i style={{ width: `${value / maximum * 100}%` }} /></div><b>{fmt(value)}</b></div>; })}</div><table><thead><tr><th>{tab === "model" ? t("analysis.colClientModel") : t("analysis.colUser")}</th><th>{t("analysis.colRequests")}</th><th>{t("analysis.colFailed")}</th><th>{t("analysis.colPrompt")}</th><th>{t("analysis.colCompletion")}</th><th>{t("analysis.colTotal")}</th></tr></thead><tbody>{sorted.map(r => <tr key={r.id}><td>{r.name}</td><td>{fmt(r.requests)}</td><td>{fmt(r.errors)}</td><td>{fmt(r.input)}</td><td>{fmt(r.output)}</td><td>{fmt(r.input + r.output)}</td></tr>)}</tbody></table></>}
      {tab === "scene" && <KeyTrendChart logs={visible} keys={keys} from={win.from} to={win.to} />}
      {tab === "latency" && <><h3>{t("analysis.latencyDistTitle")}</h3><div className="ua-ranking">{agg.latencyBuckets.map(b => <div key={b.label}><span>{b.label}</span><div className="ua-rank-track"><i style={{ width: `${b.count / Math.max(1, ...agg.latencyBuckets.map(x => x.count)) * 100}%` }} /></div><b>{t("analysis.latencyCount", { n: fmt(b.count) })}</b></div>)}</div><h3>{personal ? t("analysis.modelLatencyTitle") : t("analysis.providerLatencyTitle")}</h3><table><thead><tr><th>{personal ? t("analysis.colModel") : t("analysis.colProvider")}</th><th>{t("analysis.colRequests")}</th><th>{t("analysis.colFailed")}</th><th>{t("analysis.colAvg")}</th><th>P50</th><th>P95</th><th>P99</th></tr></thead><tbody>{agg.byProvider.map(p => <tr key={p.provider}><td>{nameOf(p.provider, providers, p.provider === "（无渠道）" ? t("analysis.unforwardedFallback") : personal ? t("analysis.historicalModel") : t("analysis.deletedProvider"))}</td><td>{fmt(p.requests)}</td><td>{fmt(p.errors)}</td>{[p.avgLatencyMs, p.p50LatencyMs, p.p95LatencyMs, p.p99LatencyMs].map((v, i) => <td key={i}>{v === null ? "—" : `${fmt(v)} ms`}</td>)}</tr>)}</tbody></table><p className="hint">{t("analysis.latencyHint", { n: visible.filter(l => l.latency_ms === null).length })}</p></>}
    </>}
    <p className="hint">{t("analysis.footerHint", { n: unknown })}</p>
  </section>;
}
