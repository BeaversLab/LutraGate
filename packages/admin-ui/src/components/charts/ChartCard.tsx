import type { ReactNode } from "react";

/**
 * 图表统一容器（dash-redesign 02）：标题 + 口径副标题 + 图例内联右上 +
 * 网格线/圆角 token 咬合。所有仪表盘图表装进同一容器语言（epic #28 设计系统）。
 * 标题/副标题由调用方传（文案 i18n 化随 #31 面板迁移，容器只管结构）。
 */
export function ChartCard({
  title,
  subtitle,
  legend,
  children,
}: {
  title: string;
  /** 口径副标题（如「近 7 天 · 本地镜像」）。 */
  subtitle?: string;
  /** 图例 chips（内联右上）。 */
  legend?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="chart-card">
      <div className="chart-card-head">
        <div className="chart-card-titles">
          <h3>{title}</h3>
          {subtitle && <span className="chart-card-sub">{subtitle}</span>}
        </div>
        {legend && <div className="chart-card-legend">{legend}</div>}
      </div>
      {children}
    </div>
  );
}

/** 图例 chip（圆点 + 文案）；color 走 token（var(--series-N) 等）。 */
export function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <span className="legend-chip">
      <span className="legend-dot" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}
