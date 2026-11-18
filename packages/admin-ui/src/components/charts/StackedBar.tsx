import { useState } from "react";
import { scaleLinear } from "d3-scale";

/**
 * 堆叠柱原语（dash-redesign 02）：成功（主色）+ 失败（danger）双色堆叠、
 * 日期 x 轴抽样、hover 浮层。数学（比例尺）走 d3-scale，渲染自绘以咬合
 * soft/dark 双主题 token（.sb-ok/.sb-fail class 填充，网格线/轴文字走
 * --input-border/--muted，KeyTrendChart 先例）。
 */

export interface StackedBarDatum {
  /** 桶起始 epoch ms。 */
  start: number;
  ok: number;
  failed: number;
}

/** x 轴标签抽样：均匀取 ≤maxLabels 个索引，恒含首尾（纯函数，单测钉采样）。 */
export function pickLabelIndices(count: number, maxLabels: number): number[] {
  if (count <= 0 || maxLabels <= 0) return [];
  if (maxLabels === 1) return [0];
  if (count <= maxLabels) {
    return Array.from({ length: count }, (_, i) => i);
  }
  const indices = new Set<number>();
  for (let i = 0; i < maxLabels; i++) {
    indices.add(Math.round((i * (count - 1)) / (maxLabels - 1)));
  }
  return [...indices].sort((a, b) => a - b);
}

/** 轴标签文案：桶粒度 ≥1 天 → 月/日；否则 → 时:分（纯函数）。 */
export function bucketAxisLabel(start: number, bucketMs: number): string {
  const d = new Date(start);
  if (bucketMs >= 86_400_000) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 浮层日期：轴标签只到时:分太薄，浮层恒带月/日（小时桶为「M/D HH:MM」，纯函数）。 */
export function bucketTipLabel(start: number, bucketMs: number): string {
  const axis = bucketAxisLabel(start, bucketMs);
  if (bucketMs >= 86_400_000) return axis;
  const d = new Date(start);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${axis}`;
}

const WIDTH = 720;
const PAD = { top: 10, right: 8, bottom: 22, left: 36 };

export function StackedBar({
  data,
  bucketMs,
  formatTooltip,
  ariaLabel = "stacked bars",
  height = 180,
}: {
  data: StackedBarDatum[];
  /** 桶粒度（轴标签日/时形态判定）。 */
  bucketMs: number;
  /** 浮层整句文案由调用方给（i18n 整句键，#16 拍板）。 */
  formatTooltip: (d: { date: string; total: number; failed: number }) => string;
  ariaLabel?: string;
  height?: number;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const n = data.length;
  const maxTotal = Math.max(1, ...data.map((d) => d.ok + d.failed));
  const y = scaleLinear().domain([0, maxTotal]).range([0, innerH]);
  const slot = n > 0 ? innerW / n : innerW;
  const barW = Math.min(slot * 0.6, 28);
  const baseline = PAD.top + innerH;
  const labelIdx = pickLabelIndices(n, 7);

  if (n === 0) return null;

  return (
    <div className="stacked-bar">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} width="100%" role="img" aria-label={ariaLabel}>
        {/* 网格线：半值 + 峰值（token 化）。 */}
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line
              className="grid-line"
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={baseline - y(maxTotal * f)}
              y2={baseline - y(maxTotal * f)}
            />
            <text className="axis-text" x={PAD.left - 6} y={baseline - y(maxTotal * f) + 4} textAnchor="end" fontSize={10}>
              {Math.round(maxTotal * f).toLocaleString()}
            </text>
          </g>
        ))}
        <line className="grid-line" x1={PAD.left} x2={WIDTH - PAD.right} y1={baseline} y2={baseline} />
        {data.map((d, i) => {
          const total = d.ok + d.failed;
          if (total === 0) return null;
          const cx = PAD.left + slot * i + slot / 2;
          const hOk = y(d.ok);
          const hFail = y(d.failed);
          return (
            <g
              key={d.start}
              className={hovered === i ? "sb-group hovered" : "sb-group"}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              <rect className="sb-ok" x={cx - barW / 2} y={baseline - hOk} width={barW} height={hOk} rx={2} />
              {d.failed > 0 && (
                <rect className="sb-fail" x={cx - barW / 2} y={baseline - hOk - hFail} width={barW} height={hFail} rx={2} />
              )}
            </g>
          );
        })}
        {labelIdx.map((i) => (
          <text
            key={data[i]!.start}
            className="axis-text"
            x={PAD.left + slot * i + slot / 2}
            y={height - 6}
            textAnchor="middle"
            fontSize={10}
          >
            {bucketAxisLabel(data[i]!.start, bucketMs)}
          </text>
        ))}
      </svg>
      {hovered !== null && (() => {
        const d = data[hovered]!;
        const left = Math.min(92, Math.max(8, ((PAD.left + slot * hovered + slot / 2) / WIDTH) * 100));
        return (
          <div className="sb-tooltip" style={{ left: `${left}%` }} role="status">
            {formatTooltip({ date: bucketTipLabel(d.start, bucketMs), total: d.ok + d.failed, failed: d.failed })}
          </div>
        );
      })()}
    </div>
  );
}
