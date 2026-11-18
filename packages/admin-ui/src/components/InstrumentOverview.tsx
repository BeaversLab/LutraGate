import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, X, RefreshCw, Pause, Play, CircleHelp } from "lucide-react";
import type { UsageAnalysisContext } from "./UsageAnalysis";
import { createPortal } from "react-dom";
import type { AdminApi, LogRow, ProviderRow, AccessKeyRow, UserRow, Identity } from "../lib/api";
import { loadAnalysisSource } from "../lib/analysis-source";
import type { LogStore } from "../lib/logstore";
import { isSuccessful } from "../lib/aggregate";
import { useLogSync } from "../hooks/useLogSync";
import { formatAxisDate, formatDateTime, formatLogTime } from "../lib/format";
import "./instrument-overview.css";

const DAY = 86_400_000;
const COLORS = ["var(--primary)", "#62abc5", "#a391cb", "#6d9d99", "#879ab3"];
const number = (n: number) => n.toLocaleString();
const tokens = (rows: LogRow[]) => rows.reduce((sum, l) => sum + (l.prompt_tokens ?? 0) + (l.completion_tokens ?? 0), 0);
const percent = (n: number, total: number) => total ? `${(n / total * 100).toFixed(1)}%` : "—";
type Selection = { kind: "key" | "provider" | "failed" | "unforwarded"; id?: string; name: string };
function matches(log: LogRow, selection: Selection | null) {
  if (!selection) return true;
  if (selection.kind === "key") return (log.access_key_id ?? "__unknown") === selection.id;
  if (selection.kind === "provider") return log.provider_id === selection.id;
  if (selection.kind === "unforwarded") return log.provider_id === null;
  return !isSuccessful(log);
}
function buckets(logs: LogRow[], start: number, count: number, field: "requests" | "failed" | "prompt_tokens" | "completion_tokens", step = DAY) {
  const result = Array<number>(count).fill(0);
  for (const l of logs) {
    const index = Math.floor((l.ts - start) / step);
    if (index >= 0 && index < count) result[index]! += field === "requests" ? 1 : field === "failed" ? Number(!isSuccessful(l)) : l[field] ?? 0;
  }
  return result;
}
function Bars({ values, secondary, labels, label, mini = false }: { values: number[]; secondary?: number[]; labels?: string[]; label: string; mini?: boolean }) {
  const max = Math.max(1, ...values.map((v, i) => v + (secondary?.[i] ?? 0)));
  return <div className={`io-bars ${mini ? "io-mini" : ""}`} role="img" aria-label={label}>
    {values.map((v, i) => <div className="io-bar-slot" key={i} title={`${labels?.[i] ?? i + 1}: ${number(v)}${secondary ? ` / ${number(secondary[i] ?? 0)}` : ""}`}>
      <div className="io-bar-stack"><i style={{ height: `${(secondary?.[i] ?? 0) / max * 100}%` }} /><b style={{ height: `${v / max * 100}%` }} /></div>
      {labels && <small>{labels[i]}</small>}
    </div>)}
  </div>;
}
function Help({ text, label }: { text: string; label?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHide = () => { if (timer.current !== null) clearTimeout(timer.current); };
  const hide = () => { cancelHide(); timer.current = setTimeout(() => setPosition(null), 150); };
  useEffect(() => () => cancelHide(), []);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const show = (element: HTMLElement) => {
    cancelHide();
    const box = element.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(box.left, window.innerWidth - 288)), top: Math.max(8, Math.min(box.bottom + 7, window.innerHeight - 140)) });
  };
  return <span className="io-help"><button type="button" className="io-help-trigger" aria-label={label ?? t("overview.helpDefault")} aria-describedby={position ? id : undefined} onMouseEnter={e => show(e.currentTarget)} onMouseLeave={hide} onFocus={e => show(e.currentTarget)} onBlur={() => setPosition(null)} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setPosition(null); } }}><CircleHelp size={14} aria-hidden="true" /></button>{position && createPortal(<span className="io-help-tooltip" id={id} role="tooltip" style={position} onMouseEnter={cancelHide} onMouseLeave={hide}>{text}</span>, document.body)}</span>;
}
export function InstrumentOverview({ api, db, onViewLogs, onAnalyze, identity }: { identity?: Identity; api: AdminApi; db: LogStore; onViewLogs?: () => void; onAnalyze?: (context: UsageAnalysisContext) => void }) {
  const { t } = useTranslation();
  const sync = useLogSync(api, db);
  const personal = identity !== undefined;
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [keys, setKeys] = useState<AccessKeyRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [metric, setMetric] = useState<"requests" | "tokens">("requests");
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const [range, setRange] = useState("7");
  const localInput = (time: number) => { const d = new Date(time); return new Date(time - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
  const [customFrom, setCustomFrom] = useState(() => localInput(Date.now() - DAY));
  const [customTo, setCustomTo] = useState(() => localInput(Date.now()));
  const [customApplied, setCustomApplied] = useState<{ from: number; to: number } | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scenePage, setScenePage] = useState(0);
  const [providerPage, setProviderPage] = useState(0);
  const [wires, setWires] = useState<{ id: string; d: string; x: number; y: number; active: boolean; selected: boolean; color: string }[]>([]);
  const [wireSize, setWireSize] = useState({ width: 1, height: 1 });
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [popover, setPopover] = useState(false);
  const [floatPosition, setFloatPosition] = useState<{ left: number; top: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const floatRef = useRef<HTMLElement>(null);
  function moveFloat(left: number, top: number) {
    const stage = stageRef.current; const panel = floatRef.current;
    if (!stage || !panel) return;
    setFloatPosition({ left: Math.max(0, Math.min(left, stage.clientWidth - panel.offsetWidth)), top: Math.max(0, Math.min(top, Math.max(0, stage.clientHeight - panel.offsetHeight))) });
  }
  function currentFloatPosition() {
    const stage = stageRef.current!.getBoundingClientRect();
    const panel = floatRef.current!.getBoundingClientRect();
    return { left: panel.left - stage.left, top: panel.top - stage.top };
  }
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState(Date.now());
  const days = range === "24h" || range === "custom" ? 7 : Number(range);
  const start = range === "custom" && customApplied ? customApplied.from : range === "24h" ? snapshot - DAY : new Date(snapshot).setHours(0, 0, 0, 0) - (days - 1) * DAY;
  const end = range === "custom" && customApplied ? customApplied.to : snapshot;
  const rangeLabel = range === "custom" && customApplied ? `${formatDateTime(start)} — ${formatDateTime(end)}` : range === "24h" ? t("overview.range24h") : t("overview.rangeDays", { days });
  const step = range === "24h" ? DAY / 24 : range === "custom" && customApplied ? Math.max(60_000, (end - start + 1) / 24) : DAY;
  const count = range === "24h" || (range === "custom" && customApplied) ? 24 : days;
  useEffect(() => {
    let active = true;
    setLoading(true);
    loadAnalysisSource(api, db, identity, start, end)
      .then(({ providers: p, keys: k, users: u, logs: l }) => { if (active) { setProviders(p); setKeys(k); setUsers(u); setLogs(l); setSnapshot(Date.now()); setError(null); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, db, sync.lastSyncAt, range, customApplied, identity?.id]);
  function close() { drag.current = null; setPopover(false); openerRef.current?.focus(); }
  useEffect(() => {
    if (!popover) return;
    closeRef.current?.focus();
    const resetPosition = () => { drag.current = null; setFloatPosition(null); };
    window.addEventListener("resize", resetPosition);
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); window.removeEventListener("resize", resetPosition); };
  }, [popover]);
  const windowLogs = useMemo(() => logs.filter(l => l.ts >= start && l.ts <= end), [logs, start, end]);
  const total = windowLogs.length;
  const failed = windowLogs.filter(l => !isSuccessful(l)).length;
  const unforwarded = windowLogs.filter(l => l.provider_id === null).length;
  const success = total - failed;
  const groups = useMemo(() => {
    const map = new Map(providers.map(p => [p.id, { id: p.id, name: p.name, logs: [] as LogRow[] }]));
    for (const l of windowLogs) if (l.provider_id) {
      if (!map.has(l.provider_id)) map.set(l.provider_id, { id: l.provider_id, name: t("overview.deletedProvider"), logs: [] });
      map.get(l.provider_id)!.logs.push(l);
    }
    return [...map.values()].sort((a, b) => b.logs.length - a.logs.length);
  }, [providers, windowLogs, t]);
  const scenes = useMemo(() => {
    const map = new Map(keys.map(k => [k.id, { id: k.id, name: k.name, owner: users.find(u => u.id === k.user_id)?.name ?? "—", hint: k.key_hint, logs: [] as LogRow[] }]));
    for (const l of windowLogs) {
      const id = l.access_key_id ?? "__unknown";
      if (!map.has(id)) map.set(id, { id, name: l.access_key_id ? t("overview.deletedKey") : t("overview.unowned"), owner: "—", hint: "", logs: [] });
      map.get(id)!.logs.push(l);
    }
    return [...map.values()].sort((a, b) => b.logs.length - a.logs.length);
  }, [keys, users, windowLogs, t]);
  const filtered = windowLogs.filter(l => matches(l, selection));
  const dates = Array.from({ length: count }, (_, i) => { const date = new Date(start + i * step); return range === "24h" ? t("overview.hourSuffix", { h: String(date.getHours()).padStart(2, "0") }) : formatAxisDate(start + i * step, step < DAY); });
  const series = (data: LogRow[], field: "requests" | "failed" | "prompt_tokens" | "completion_tokens") => buckets(data, start, count, field, step);
  const requests = series(filtered, "requests");
  const failures = series(filtered, "failed");
  const value = (rows: LogRow[]) => metric === "tokens" ? tokens(rows) : rows.length;
  const metricTotal = value(windowLogs);
  const metricLabel = metric === "tokens" ? t("overview.metricLabelTokens") : t("overview.metricLabelRequests");
  const metricSeries = (rows: LogRow[]) => metric === "tokens" ? series(rows, "prompt_tokens").map((v, i) => v + series(rows, "completion_tokens")[i]!) : series(rows, "requests");
  const flowActive = !paused && !reducedMotion && metricTotal > 0;
  const ring = [...groups.map((g, i) => ({ ...g, count: value(g.logs), color: COLORS[i % COLORS.length]! })), { id: "unforwarded", name: t("overview.unforwarded"), logs: [] as LogRow[], count: value(windowLogs.filter(l => l.provider_id === null)), color: "var(--amber)" }];
  const scenePages = Math.max(1, Math.ceil(scenes.length / 4));
  const shownScenePage = Math.min(scenePage, scenePages - 1);
  const matchingGroups = groups.filter(g => g.name.toLowerCase().includes(query.toLowerCase()));
  const providerPages = Math.max(1, Math.ceil(matchingGroups.length / 4));
  const shownProviderPage = Math.min(providerPage, providerPages - 1);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const box = stage.getBoundingClientRect();
      const core = stage.querySelector(".io-core-diagram")?.getBoundingClientRect();
      if (!core || !box.width) return;
      const centerX = core.left + core.width / 2 - box.left;
      const centerY = core.top + core.height / 2 - box.top;
      const radius = core.width * 145 / 360;
      setWireSize({ width: box.width, height: box.height });
      const next = [...stage.querySelectorAll<HTMLElement>("[data-flow-node]")].map(node => {
        const bounds = node.getBoundingClientRect();
        const incoming = node.dataset.flowSide === "in";
        const x = (incoming ? bounds.right : bounds.left) - box.left;
        const y = bounds.top + bounds.height / 2 - box.top;
        const ringX = centerX + (incoming ? -radius : radius);
        const gap = Math.abs(ringX - x) * .5;
        return {
          id: node.dataset.flowNode!, x, y,
          d: incoming ? `M${x} ${y} C${x + gap} ${y} ${ringX - gap} ${centerY} ${ringX} ${centerY}` : `M${ringX} ${centerY} C${ringX + gap} ${centerY} ${x - gap} ${y} ${x} ${y}`,
          active: node.dataset.flowActive === "true",
          selected: selection?.id === node.dataset.flowNode,
          color: node.dataset.flowColor ?? "var(--primary)",
        };
      });
      setWires(next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(stage);
    stage.querySelectorAll(".io-core-diagram,[data-flow-node]").forEach(node => observer?.observe(node));
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [scenes, groups, metric, query, shownScenePage, shownProviderPage, selection]);
  let offset = 0;
  function choose(s: Selection, float = false) { openerRef.current = document.activeElement as HTMLElement; setSelection(s); setPopover(float); }
  return <section className="instrument-overview">
    <header className="io-heading"><div><h2>{personal ? t("overview.myTitle") : t("overview.title")}</h2><Help label={t("overview.helpTitle")} text={personal ? t("overview.helpPersonal") : t("overview.helpAdmin")} /></div><div className="io-actions"><select aria-label={t("overview.rangeAria")} value={range} onChange={e => { setRange(e.target.value); setRangeError(null); setSelection(null); setPopover(false); }}><option value="24h">{t("overview.range24h")}</option><option value={7}>{t("overview.rangeDays", { days: 7 })}</option><option value={14}>{t("overview.rangeDays", { days: 14 })}</option><option value={30}>{t("overview.rangeDays", { days: 30 })}</option><option value="custom">{t("overview.rangeCustom")}</option></select><Help label={sync.lastResult ? t("overview.syncHelpLabelCount", { n: sync.lastResult.inserted }) : t("overview.syncHelpLabel")} text={sync.lastResult ? `${t("overview.syncHelpInserted", { n: sync.lastResult.inserted })}${sync.lastResult.truncated ? t("overview.syncHelpTruncated") : t("overview.syncHelpDone")}` : t("overview.syncHelpIdle")} /><button disabled={sync.busy} onClick={sync.syncNow}><RefreshCw size={13} />{sync.busy ? t("overview.syncing") : t("overview.syncNow")}</button></div></header>
    {range === "custom" && <form className="io-custom-range" onSubmit={e => {
      e.preventDefault();
      const from = new Date(customFrom).getTime(); const to = new Date(customTo).getTime();
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) { setRangeError(t("overview.customRangeError")); return; }
      setRangeError(null); setCustomApplied({ from, to }); setSelection(null); setPopover(false);
    }}><label>{t("overview.customFrom")}<input aria-label={t("overview.customFrom")} type="datetime-local" required value={customFrom} onChange={e => setCustomFrom(e.target.value)} /></label><span>{t("overview.customSep")}</span><label>{t("overview.customTo")}<input aria-label={t("overview.customTo")} type="datetime-local" required value={customTo} onChange={e => setCustomTo(e.target.value)} /></label><button type="submit">{t("overview.customApply")}</button><Help label={t("overview.customHelpTitle")} text={`${t("overview.customHelpLocal")}${customApplied ? t("overview.customHelpApplied") : t("overview.customHelpIdle")}`} />{rangeError && <span role="alert" className="error">{rangeError}</span>}</form>}
    {(error || sync.error) && <p className="error" role="alert">{t("overview.loadError", { message: error ?? sync.error ?? "" })}</p>}
    {loading && <p role="status" className="io-notice">{t("overview.loading")}</p>}
    <div className="io-metrics">{[[t("overview.metricRequests"), number(total)], [t("overview.metricSuccessRate"), percent(success, total)], [t("overview.metricFailed"), number(failed)], [t("overview.metricPromptTokens"), number(windowLogs.reduce((s, l) => s + (l.prompt_tokens ?? 0), 0))], [t("overview.metricCompletionTokens"), number(windowLogs.reduce((s, l) => s + (l.completion_tokens ?? 0), 0))]].map(([name, value], i) => <div key={name}><span>{name}</span>{i === 2 ? <button onClick={() => choose({ kind: "failed", name: t("overview.selectAllFailed") }, true)}>{value}</button> : <strong>{value}</strong>}{i !== 1 && <span className={`io-metric-trend io-metric-trend-${i}`}><Bars values={series(windowLogs, i === 2 ? "failed" : i === 3 ? "prompt_tokens" : i === 4 ? "completion_tokens" : "requests")} mini label={i === 2 ? t("overview.trendFailed") : i === 3 ? t("overview.trendPrompt") : i === 4 ? t("overview.trendCompletion") : t("overview.trendRequests")} /></span>}</div>)}</div>
    <div className="io-visual-toolbar"><div role="group" aria-label={t("overview.metricToggleAria")}><button aria-pressed={metric === "requests"} onClick={() => setMetric("requests")}>{t("overview.metricRequestsBtn")}</button><button aria-pressed={metric === "tokens"} onClick={() => setMetric("tokens")}>{t("overview.metricTokensBtn")}</button><Help label={t("overview.flowHelpTitle")} text={`${t("overview.flowHelpBase")}${reducedMotion ? t("overview.flowHelpReduced") : t("overview.flowHelpPause")}`} /></div><button className="io-pause-control" disabled={reducedMotion} onClick={() => setPaused(v => !v)}>{paused || reducedMotion ? <Play size={13} /> : <Pause size={13} />}{paused || reducedMotion ? t("overview.resumeFlow") : t("overview.pauseFlow")}</button></div>
    <div ref={stageRef} className={`io-stage ${flowActive ? "io-flow-running" : "io-flow-paused"}`}>

      <svg className="io-wires" width="100%" height="100%" viewBox={`0 0 ${wireSize.width} ${wireSize.height}`} preserveAspectRatio="none" aria-hidden="true">{wires.map((wire, i) => <g key={wire.id} style={{ color: wire.color }} className={`${wire.selected ? "io-wire-selected" : ""} ${wire.active ? "" : "io-wire-idle"}`}><path d={wire.d} className="io-flow-track" />{wire.active && <path d={wire.d} pathLength="100" className="io-flow-pulse" style={{ animationDelay: `${-i * .5}s` }} />}<circle cx={wire.x} cy={wire.y} r="3.5" className="io-wire-end" /></g>)}</svg>
      <div className="io-scenes"><h3>{t("overview.scenesTitle")} <small>{scenes.length}</small></h3><div className="io-scene-list">{scenes.slice(shownScenePage * 4, shownScenePage * 4 + 4).map(s => <button data-flow-node={s.id} data-flow-side="in" data-flow-active={value(s.logs) > 0} className={`io-scene ${selection?.id === s.id ? "selected" : ""}`} key={s.id} onClick={() => choose({ kind: "key", id: s.id, name: s.name })}><span className="io-avatar">{Array.from(s.name).slice(0, 2).join("")}</span><div><strong>{s.name}</strong><small>{s.owner}{s.hint ? ` · ••••${s.hint}` : ""}</small><b>{number(value(s.logs))} <small>{metric === "tokens" ? t("quota.tokens") : t("overview.unitTimes")}</small></b><small>{metric === "tokens" ? t("overview.requestWithTokens", { n: number(s.logs.length), input: number(s.logs.reduce((n, l) => n + (l.prompt_tokens ?? 0), 0)), output: number(s.logs.reduce((n, l) => n + (l.completion_tokens ?? 0), 0)) }) : t("overview.knownTokens", { n: number(tokens(s.logs)) })}</small><Bars values={metricSeries(s.logs)} mini label={t("overview.trendNamed", { name: s.name, metric: metricLabel })} /><small>{s.logs.length ? t("overview.failedHistoryCount", { n: s.logs.filter(l => !isSuccessful(l)).length }) : t("overview.noCalls")}</small></div></button>)}{!scenes.length && <p className="io-notice">{t("overview.emptyScenes")}</p>}</div>{scenePages > 1 && <div className="io-pagination"><button disabled={shownScenePage === 0} onClick={() => setScenePage(shownScenePage - 1)}>{t("overview.prevPage")}</button><small>{shownScenePage + 1} / {scenePages}</small><button disabled={shownScenePage >= scenePages - 1} onClick={() => setScenePage(shownScenePage + 1)}>{t("overview.nextPage")}</button></div>}</div>
      <div className="io-core"><div className="io-core-title"><span className="io-caption">{rangeLabel} · {t("overview.nonRealtime")}</span><Help label={t("overview.ringHelpTitle")} text={t("overview.ringHelpText", { metric: metricLabel })} /></div><svg className="io-core-diagram" viewBox="0 0 360 360" role="img" aria-label={t("overview.ringAria", { metric: metricLabel })}>

        <circle cx="180" cy="180" r="132" fill="none" stroke="var(--input-border)" strokeWidth="23" opacity=".35" />
        {ring.filter(g => g.count > 0).map(g => { const length = g.count / metricTotal * 100; const current = offset; offset += length; return <circle key={g.id} cx="180" cy="180" r="132" pathLength="100" fill="none" stroke={g.color} strokeWidth="23" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-current} transform="rotate(-90 180 180)" className="io-ring-segment" tabIndex={0} role="button" aria-label={`${g.name} ${percent(g.count, metricTotal)}`} onClick={() => choose(g.id === "unforwarded" ? { kind: "unforwarded", name: t("overview.unforwarded") } : { kind: "provider", id: g.id, name: g.name }, true)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(g.id === "unforwarded" ? { kind: "unforwarded", name: t("overview.unforwarded") } : { kind: "provider", id: g.id, name: g.name }, true); } }}><title>{g.name} · {number(g.count)} {metricLabel} · {percent(g.count, metricTotal)}</title></circle>; })}
        <circle cx="180" cy="180" r="111" fill="none" stroke="var(--input-border)" strokeWidth="5" strokeDasharray="1 5" />
        <circle cx="180" cy="180" r="91" fill="none" stroke="var(--input-border)" strokeWidth="14" opacity=".4" />
        {total > 0 && <><circle cx="180" cy="180" r="91" fill="none" stroke="var(--ok)" strokeWidth="14" pathLength="100" strokeDasharray={`${success / total * 100} ${failed / total * 100}`} transform="rotate(-90 180 180)" /><circle cx="180" cy="180" r="91" fill="none" stroke="var(--amber)" strokeWidth="14" pathLength="100" strokeDasharray={`${failed / total * 100} ${success / total * 100}`} strokeDashoffset={-success / total * 100} transform="rotate(-90 180 180)" /></>}
        <text x="180" y="148" textAnchor="middle" className="io-center-label">{metric === "tokens" ? t("overview.centerTokens") : t("overview.centerRequests")}</text>
        <text x="180" y="188" textAnchor="middle" className="io-center-total">{metric === "tokens" ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(metricTotal) : number(total)}</text>
        <text x="180" y="215" textAnchor="middle" className="io-center-detail">{metric === "tokens" ? t("overview.inputTokensValue", { tokens: new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(windowLogs.reduce((n, l) => n + (l.prompt_tokens ?? 0), 0)) }) : t("overview.successRateValue", { rate: percent(success, total) })}</text>
        {metric === "tokens" && <text x="180" y="233" textAnchor="middle" className="io-center-detail">{t("overview.outputTokensValue", { tokens: new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(windowLogs.reduce((n, l) => n + (l.completion_tokens ?? 0), 0)) })}</text>}

        {metricTotal > 0 && <circle cx="180" cy="180" r="150" className="io-orbit" fill="none" stroke="var(--primary)" strokeWidth="1" strokeDasharray="16 145 6 77" />}
      </svg><div className="io-ring-legend"><span>{t("overview.legendSuccess", { n: number(success) })}</span><button onClick={() => choose({ kind: "failed", name: t("overview.selectAllFailed") }, true)}>{t("overview.legendFailed", { n: number(failed) })}</button></div><button className="io-unforwarded" onClick={() => choose({ kind: "unforwarded", name: t("overview.unforwarded") }, true)}>{t("overview.unforwardedButton", { n: number(unforwarded), rate: percent(unforwarded, total) })}</button></div>
      <div className="io-providers"><div className="io-provider-title"><h3 className="io-title-with-help">{personal ? t("overview.modelsTitle") : t("overview.providersTitle")}<Help label={personal ? t("overview.modelsHelpTitle") : t("overview.providersHelpTitle")} text={`${metric === "tokens" ? t("overview.providersHelpIncomplete", { n: windowLogs.filter(l => l.prompt_tokens === null || l.completion_tokens === null).length }) : ""}${t("overview.providersHelpBase")}`} /></h3><label><Search size={13} /><input aria-label={personal ? t("overview.searchModels") : t("overview.searchProviders")} placeholder={personal ? t("overview.searchModels") : t("overview.searchProviders")} value={query} onChange={e => { setQuery(e.target.value); setProviderPage(0); }} /></label></div><div className="io-provider-list"><table><thead><tr><th>{personal ? t("overview.colModel") : t("overview.colProvider")}</th><th>{t("overview.colMetricShare", { metric: metricLabel })}</th><th>{t("overview.colSuccessRate")}</th></tr></thead><tbody>{matchingGroups.slice(shownProviderPage * 4, shownProviderPage * 4 + 4).map(g => { const i = groups.indexOf(g); return <tr key={g.id} data-flow-node={g.id} data-flow-side="out" data-flow-active={value(g.logs) > 0} data-flow-color={COLORS[i % COLORS.length]}><td><button className="io-provider-button" onClick={() => choose({ kind: "provider", id: g.id, name: g.name })}><span style={{ background: COLORS[i % COLORS.length] }}>{String(i + 1).padStart(2, "0")}</span>{g.name}</button></td><td>{number(value(g.logs))} · {percent(value(g.logs), metricTotal)}<small className="io-secondary-value">{metric === "tokens" ? t("overview.requestCount", { n: number(g.logs.length) }) : `${number(tokens(g.logs))} ${t("quota.tokens")}`}</small><div className="io-share"><i style={{ width: `${metricTotal ? value(g.logs) / metricTotal * 100 : 0}%`, background: COLORS[i % COLORS.length] }} /></div></td><td>{percent(g.logs.filter(isSuccessful).length, g.logs.length)}</td></tr>; })}</tbody></table>{!groups.length && <p className="io-notice">{personal ? t("overview.emptyModels") : t("overview.emptyProviders")}</p>}{groups.length > 0 && !matchingGroups.length && <p className="io-notice">{personal ? t("overview.noMatchModels") : t("overview.noMatchProviders")}</p>}</div>{providerPages > 1 && <div className="io-pagination"><button disabled={shownProviderPage === 0} onClick={() => setProviderPage(shownProviderPage - 1)}>{t("overview.prevPage")}</button><small>{shownProviderPage + 1} / {providerPages}</small><button disabled={shownProviderPage >= providerPages - 1} onClick={() => setProviderPage(shownProviderPage + 1)}>{t("overview.nextPage")}</button></div>}<div className="io-provider-foot"><small>{personal ? t("overview.countModels", { n: groups.length }) : t("overview.countProviders", { n: groups.length })}</small></div></div>
      {popover && selection && <aside ref={floatRef} className="io-popover" role="dialog" aria-label={selection.name} style={floatPosition ? { left: floatPosition.left, top: floatPosition.top, right: "auto" } : undefined}><header className="io-drag-handle" tabIndex={0} aria-label={t("overview.popoverDragAria")} onPointerDown={e => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        drag.current = { x: e.clientX, y: e.clientY, ...currentFloatPosition() };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }} onPointerMove={e => {
        if (!drag.current) return;
        moveFloat(drag.current.left + e.clientX - drag.current.x, drag.current.top + e.clientY - drag.current.y);
      }} onPointerUp={e => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={e => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault(); const pos = currentFloatPosition(); const distance = e.shiftKey ? 40 : 10;
        moveFloat(pos.left + (e.key === "ArrowRight" ? distance : e.key === "ArrowLeft" ? -distance : 0), pos.top + (e.key === "ArrowDown" ? distance : e.key === "ArrowUp" ? -distance : 0));
      }}><h3>{selection.name}</h3><button ref={closeRef} aria-label={t("overview.popoverClose")} onClick={close}><X size={17} /></button></header><small>{rangeLabel} · {t("overview.popoverFilter")}</small><div className="io-pop-stats"><strong>{number(filtered.length)}<small> {t("overview.unitTimes")}</small></strong><span>{t("overview.shareOfTotal")}<b>{percent(filtered.length, total)}</b></span></div><p>{selection.kind === "unforwarded" ? t("overview.unforwardedDetail") : t("overview.failedHistoryCount", { n: filtered.filter(l => !isSuccessful(l)).length })}</p><Bars values={requests} label={t("overview.popoverBarsLabel")} /><button onClick={() => { setPopover(false); const target = document.getElementById("io-recent"); target?.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "instant" : "smooth" }); target?.focus({ preventScroll: true }); }}>{t("overview.locateRequests")}</button></aside>}
    </div>
    <div className="io-context"><span className="io-path-title">{selection?.name ?? t("overview.allScenes")} → LutraGate → {selection?.kind === "provider" ? selection.name : t("overview.allOutputs")}<Help label={t("overview.pathHelpTitle")} text={personal ? t("overview.pathHelpModels") : t("overview.pathHelpProviders")} /></span>{selection ? <button onClick={() => { setSelection(null); setPopover(false); }}>{t("overview.clearFilter")}</button> : null}</div>
    <div className="io-bottom"><div className="io-trends"><div className="io-recent-heading"><h3>{t("overview.trendsTitle")} <small>{selection?.name ?? t("overview.allRequests")}</small></h3>{onAnalyze && <button onClick={() => onAnalyze({ from: start, to: end, key: selection?.kind === "key" ? selection.id : undefined, provider: selection?.kind === "provider" ? selection.id : undefined, failedOnly: selection?.kind === "failed", unforwardedOnly: selection?.kind === "unforwarded" })}>{t("overview.detailAnalysis")}</button>}</div><div className="io-chart-label"><span>{t("overview.chartOk")}</span><span>{t("overview.chartFail")}</span></div><Bars values={requests.map((v, i) => v - failures[i]!)} secondary={failures} labels={dates} label={t("overview.dailyBarsLabel")} /><div className="io-chart-label io-title-with-help">{t("overview.tokenChartLabel")}<Help label={t("overview.tokenHelpTitle")} text={t("overview.tokenHelpText", { n: filtered.filter(l => l.prompt_tokens === null || l.completion_tokens === null).length })} /></div><div className="io-token-chart"><Bars values={series(filtered, "prompt_tokens")} secondary={series(filtered, "completion_tokens")} labels={dates} label={t("overview.tokenBarsLabel")} /></div></div><div className="io-recent" id="io-recent" tabIndex={-1} aria-label={t("overview.recentAria")}><div className="io-recent-heading"><h3>{t("overview.recentTitle")} <small>{t("overview.recentShown", { shown: Math.min(3, filtered.length), total: number(filtered.length) })}</small></h3>{onViewLogs && <button onClick={onViewLogs}>{t("overview.viewAllLogs")}</button>}</div><div className="io-table-scroll"><table><thead><tr><th>{t("overview.colTime")}</th><th>{t("overview.colScene")}</th><th>{t("overview.colModel")}</th><th>{t("overview.colPrompt")}</th><th>{t("overview.colCompletion")}</th><th>{t("overview.colResult")}</th></tr></thead><tbody>{[...filtered].sort((a, b) => b.ts - a.ts).slice(0, 3).map(l => <tr key={l.id} title={`${l.error_message ?? l.request_id} · ${t("overview.latencyTitle", { latency: l.latency_ms === null ? t("overview.latencyUnknown") : `${l.latency_ms} ms` })}`}><td>{formatLogTime(l.ts)}</td><td>{scenes.find(s => s.id === (l.access_key_id ?? "__unknown"))?.name ?? t("overview.historyRecord")}</td><td>{l.upstream_model ?? l.client_model}</td><td className="io-token-cell">{l.prompt_tokens === null ? "—" : number(l.prompt_tokens)}</td><td className="io-token-cell">{l.completion_tokens === null ? "—" : number(l.completion_tokens)}</td><td style={{ color: isSuccessful(l) ? "var(--ok)" : "var(--amber)" }}>{l.error_type ?? (isSuccessful(l) ? t("overview.resultSuccess") : `HTTP ${l.status}`)}</td></tr>)}</tbody></table>{!filtered.length && <p className="io-notice">{t("overview.emptyRecent")}</p>}</div></div></div>
  </section>;
}
