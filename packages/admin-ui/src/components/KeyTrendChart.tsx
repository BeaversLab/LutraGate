import { useMemo, useState } from "react";
import type { AccessKeyRow, LogRow } from "../lib/api";
import { byKeyTimeline, type KeyTrendSeries } from "../lib/aggregate";

/**
 * 按场景（访问 key）趋势图（desktop 04）：多选 ≤8 把 key（默认请求数 top3）、
 * 日粒度折线叠加、requests/tokens 指标切换。两块仪表盘共用——管理盘传跨用户
 * 全部 key，我的盘只传自己的 key；行也由父面板按各自范围先行过滤。
 */

const MAX_KEYS = 8;
const DEFAULT_KEYS = 3;
const DAY_MS = 86_400_000;

/** 折线配色（≤8 把 key）：--series-1..8 token（dash-redesign 02 色板化，两主题各一套）。
 * SVG 呈现属性不吃 var()，走 style 内联 CSS。 */
const seriesColor = (i: number): string => `var(--series-${(i % 8) + 1})`;

type Metric = "requests" | "tokens";

export function keyDisplayName(key: AccessKeyRow): string {
  return `${key.name}（****${key.key_hint}）`;
}

/** key 已删但日志行仍引用其 id 时的可读回退（两处面板共用，desktop 05）。 */
export function deletedKeyName(id: string): string {
  return `已删除的 key（${id.slice(0, 8)}…）`;
}

export function KeyTrendChart({
  logs,
  keys,
  from,
  to,
}: {
  logs: LogRow[];
  keys: AccessKeyRow[];
  from?: number;
  to?: number;
}) {
  // 未给窗口（如「全部」档）时从数据推导；空数据回退最近 7 天。
  const window = useMemo(() => {
    if (from !== undefined && to !== undefined) return { from, to };
    if (logs.length > 0) {
      let min = Infinity;
      let max = -Infinity;
      for (const l of logs) {
        min = Math.min(min, l.ts);
        max = Math.max(max, l.ts);
      }
      return { from: min, to: max };
    }
    const now = Date.now();
    return { from: now - 7 * DAY_MS, to: now };
  }, [from, to, logs]);

  // 窗口内每把 key 的请求数（默认勾选 top3 与排序依据）。
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of logs) {
      if (l.access_key_id === null) continue;
      map.set(l.access_key_id, (map.get(l.access_key_id) ?? 0) + 1);
    }
    return map;
  }, [logs]);

  const orderedKeys = useMemo(
    () => [...keys].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.name.localeCompare(b.name)),
    [keys, counts],
  );

  const [selected, setSelected] = useState<string[]>([]);
  const [metric, setMetric] = useState<Metric>("requests");
  /** 当前指标取值器（requests / tokens 单一来源）。 */
  const value = (p: { requests: number; tokens: number }): number => (metric === "requests" ? p.requests : p.tokens);

  // 空选择 = 默认 top3（窗口变化自动跟随；用户改选后以用户为准）。
  const effectiveSelected = useMemo(
    () => (selected.length > 0 ? selected : orderedKeys.slice(0, DEFAULT_KEYS).map((k) => k.id)),
    [selected, orderedKeys],
  );

  const series: KeyTrendSeries[] = useMemo(
    () => byKeyTimeline(logs, effectiveSelected, window.from, window.to),
    [logs, effectiveSelected, window.from, window.to],
  );

  const nameOf = (id: string) => {
    const key = keys.find((k) => k.id === id);
    return key === undefined ? deletedKeyName(id) : keyDisplayName(key);
  };

  const width = 720;
  const height = 200;
  const pad = { left: 48, right: 12, top: 12, bottom: 24 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const n = Math.max(series[0]?.points.length ?? 1, 1);
  const maxValue = Math.max(1, ...series.flatMap((s) => s.points.map(value)));

  const x = (i: number) => pad.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / maxValue) * innerH;

  const hasData = series.some((s) => s.points.some((p) => p.requests > 0));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const base = prev.length > 0 ? prev : orderedKeys.slice(0, DEFAULT_KEYS).map((k) => k.id);
      return base.includes(id) ? base.filter((k) => k !== id) : base.length >= MAX_KEYS ? base : [...base, id];
    });
  };

  return (
    <div className="chart key-trend" data-testid="key-trend">
      <div className="filters">
        <div className="tab-group" role="group" aria-label="指标">
          {(["requests", "tokens"] as const).map((m) => (
            <button
              key={m}
              className={metric === m ? "tab active" : "tab"}
              aria-pressed={metric === m}
              onClick={() => setMetric(m)}
            >
              {m === "requests" ? "请求数" : "Tokens"}
            </button>
          ))}
        </div>
        <div className="key-picker" role="group" aria-label="场景 Key 多选">
          {orderedKeys.map((k) => {
            const checked = effectiveSelected.includes(k.id);
            const disabled = !checked && effectiveSelected.length >= MAX_KEYS;
            return (
              <label key={k.id} className={disabled ? "key-option disabled" : "key-option"}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(k.id)}
                />
                {nameOf(k.id)}
              </label>
            );
          })}
          {orderedKeys.length === 0 && <span className="empty">暂无访问 Key。</span>}
        </div>
      </div>

      {series.length === 0 || !hasData ? (
        <p className="empty">所选范围内暂无请求。</p>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="按场景趋势">
          {/* y 轴刻度：0 / 半值 / 峰值 */}
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line className="grid-line" x1={pad.left} x2={width - pad.right} y1={y(maxValue * f)} y2={y(maxValue * f)} />
              <text className="axis-text" x={pad.left - 6} y={y(maxValue * f) + 4} textAnchor="end" fontSize={10}>
                {Math.round(maxValue * f).toLocaleString()}
              </text>
            </g>
          ))}
          {series.map((s, si) => (
            <polyline
              key={s.keyId}
              fill="none"
              style={{ stroke: seriesColor(si) }}
              strokeWidth={2}
              points={s.points.map((p, i) => `${x(i)},${y(value(p))}`).join(" ")}
            >
              <title>{`${nameOf(s.keyId)}：${s.points.reduce((n, p) => n + value(p), 0).toLocaleString()} ${metric === "requests" ? "次" : "tokens"}`}</title>
            </polyline>
          ))}
          {series[0]!.points.map((p, i) =>
            i % Math.ceil(n / 8) === 0 || i === n - 1 ? (
              <text key={p.start} className="axis-text" x={x(i)} y={height - 6} textAnchor="middle" fontSize={10}>
                {new Date(p.start).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}
              </text>
            ) : null,
          )}
        </svg>
      )}

      <div className="trend-legend">
        {series.map((s, si) => (
          <span key={s.keyId} className="legend-item">
            <span className="legend-swatch" style={{ background: seriesColor(si) }} />
            {nameOf(s.keyId)}：
            {s.points.reduce((acc, p) => acc + value(p), 0).toLocaleString()}
            {metric === "requests" ? " 次" : " tokens"}
          </span>
        ))}
      </div>
    </div>
  );
}
