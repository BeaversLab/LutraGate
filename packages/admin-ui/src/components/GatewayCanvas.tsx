import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DELETED_KEY_NODE_ID,
  NO_PROVIDER_NODE_ID,
  type AdminCanvasData,
  type CanvasNode,
} from "../lib/canvas-aggregate";

/** 每侧最多同时展示的节点数（demo 拍板：6 个，连线密度有界）。 */
const PER_SIDE = 6;

/**
 * 网关节点画布（UI 2.0 #12，展示组件）：入口 Key → 网关 → 出口供应商 三列，
 * 连线标注 7 天请求量；点选节点只突出它与网关的连线并更新详情条；橙色 = 窗口
 * 内出现过失败（历史告警非实时健康）；零流量节点显示但无连线。每侧分页 +
 * 分组筛选 + 名称搜索按真实节点数生效。流动光点动效带暂停开关，
 * prefers-reduced-motion 时全部停用（SVG 几何与动效不进测试面）。
 */
export function GatewayCanvas({
  data,
  variant = "admin",
  reducedMotion = false,
  onViewLogs,
}: {
  data: AdminCanvasData;
  /** 个人总览（UI 2.0 #13）复用同一画布：出口=上游模型，标题走 personalTitle。 */
  variant?: "admin" | "personal";
  /** 注入式（测试/容器可控）；生产由容器读 matchMedia。 */
  reducedMotion?: boolean;
  onViewLogs?: () => void;
}) {
  const { t } = useTranslation();
  const title = t(variant === "personal" ? "canvas.personalTitle" : "canvas.title");
  // 个人画布出口=上游模型：列标注与分页 aria 随 variant 换词。
  const outputLabel = t(variant === "personal" ? "canvas.outputModelColumn" : "canvas.outputColumn");
  const [activeNodeId, setActiveNodeId] = useState<string>("gateway");
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [leftGroup, setLeftGroup] = useState("");
  const [rightGroup, setRightGroup] = useState("");
  const [leftPage, setLeftPage] = useState(0);
  const [rightPage, setRightPage] = useState(0);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // SMIL 光点（animateMotion）不受 CSS animation-play-state 管：暂停/减少动效时
  // 显式 pauseAnimations；flow-pulse 走 CSS（.flow-paused / reduced-motion 媒体查询）。
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null || typeof svg.pauseAnimations !== "function") return;
    if (paused || reducedMotion) svg.pauseAnimations();
    else svg.unpauseAnimations();
  }, [paused, reducedMotion, activeNodeId, leftPage, rightPage, query, leftGroup, rightGroup]);

  const displayName = (node: CanvasNode): string => {
    if (node.id === DELETED_KEY_NODE_ID) return t("canvas.deletedKeys");
    if (node.id === NO_PROVIDER_NODE_ID) return t("canvas.noProvider");
    return node.name;
  };

  const filterSide = (nodes: CanvasNode[], group: string): CanvasNode[] =>
    nodes.filter(
      (n) =>
        (group === "" || n.group === group) &&
        (query === "" || displayName(n).toLowerCase().includes(query.toLowerCase())),
    );

  // 依赖含 t：语言切换后哨兵节点（已删除/无渠道）的展示名参与搜索过滤，需重算。
  const leftFiltered = useMemo(() => filterSide(data.inputs, leftGroup), [data.inputs, leftGroup, query, t]);
  const rightFiltered = useMemo(() => filterSide(data.outputs, rightGroup), [data.outputs, rightGroup, query, t]);

  // 页码越界钳制（筛选缩小结果后回到末页）。
  const clampPage = (page: number, total: number) => Math.min(page, Math.max(0, Math.ceil(total / PER_SIDE) - 1));
  const leftPageClamped = clampPage(leftPage, leftFiltered.length);
  const rightPageClamped = clampPage(rightPage, rightFiltered.length);
  const visibleLeft = leftFiltered.slice(leftPageClamped * PER_SIDE, leftPageClamped * PER_SIDE + PER_SIDE);
  const visibleRight = rightFiltered.slice(rightPageClamped * PER_SIDE, rightPageClamped * PER_SIDE + PER_SIDE);

  const groupsOf = (nodes: CanvasNode[]): string[] => [...new Set(nodes.map((n) => n.group).filter((g) => g !== ""))];

  // 纵向布点（demo 几何）：1 个节点居中，否则 14%–86% 均分；y*4 = viewBox 高 400 内的像素位。
  const yOf = (i: number, len: number) => (len === 1 ? 50 : 14 + (i * 72) / (len - 1));
  const noMotion = paused || reducedMotion;

  const selected =
    activeNodeId === "gateway"
      ? null
      : [...data.inputs, ...data.outputs].find((n) => n.id === activeNodeId) ?? null;

  const nodeSmall = (n: CanvasNode): string => {
    const parts = [n.group, t("canvas.requests", { count: n.count })].filter((p) => p !== "");
    if (n.failed > 0) parts.push(t("canvas.failedHistory", { count: n.failed }));
    return parts.join(" · ");
  };

  const flowEdge = (n: CanvasNode, side: "left" | "right", y: number, index: number) => {
    // 零流量节点显示但无连线（spec 故事 8）——边只画有流量的节点。
    if (n.count === 0) return null;
    const focused = activeNodeId === "gateway" || activeNodeId === n.id;
    const d =
      side === "left"
        ? `M210 ${y * 4} C310 ${y * 4} 290 200 380 200`
        : `M620 200 C710 200 690 ${y * 4} 790 ${y * 4}`;
    return (
      <g key={`${side}-${n.id}`} className={`edge ${focused ? "focused" : "muted-edge"}`}>
        <path className={n.failed > 0 ? "warning" : undefined} d={d} />
        {!reducedMotion && (
          <>
            <path className="flow-pulse" style={{ animationDelay: `-${(n.count % 11) / 3}s` }} d={d} />
            <circle className="flow-dot" r="4">
              <animateMotion dur="2.8s" begin={`-${(n.count % 7) / 3}s`} repeatCount="indefinite" path={d} />
            </circle>
          </>
        )}
        <text x={side === "left" ? 245 : 725} y={y * 4 - 10}>{n.count}</text>
        {/* 供组件测试定位（几何不进测试面，但要能数出边）。 */}
        <title data-testid={`edge-${side}-${index}`}>{`${displayName(n)}: ${n.count}`}</title>
      </g>
    );
  };

  const graphNode = (n: CanvasNode, side: "left" | "right", y: number) => (
    <button
      key={n.id}
      type="button"
      className={`node ${side === "left" ? "in" : "out"} ${n.failed > 0 ? "warn" : ""} ${
        activeNodeId === n.id ? "chosen" : ""
      }`}
      style={{ top: `calc(${y}% - 25px)` }}
      aria-pressed={activeNodeId === n.id}
      data-testid={`node-${side}`}
      onClick={() => setActiveNodeId(n.id)}
    >
      <span className="node-status" aria-hidden="true"><i /></span>
      <span>
        <strong>{displayName(n)}</strong>
        <small>{nodeSmall(n)}</small>
      </span>
    </button>
  );

  return (
    <>
    <section
      className={`graph-shell flow-canvas ${paused ? "flow-paused" : ""}`}
      aria-label={title}
    >
      <div className="graph-top">
        <div>
          <h2>{title}</h2>
          <p>{t("canvas.hint")}</p>
        </div>
        <div className="canvas-tools">
          <button
            type="button"
            className="small"
            aria-pressed={paused}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? t("canvas.play") : t("canvas.pause")}
          </button>
        </div>
      </div>

      <div className="canvas-filters">
        {groupsOf(data.inputs).length > 0 && (
          <label>
            {t("canvas.inputColumn")}
            <select aria-label={t("canvas.inputGroupLabel")} value={leftGroup} onChange={(e) => { setLeftGroup(e.target.value); setLeftPage(0); }}>
              <option value="">{t("canvas.allGroups")}</option>
              {groupsOf(data.inputs).map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </label>
        )}
        <input
          type="search"
          aria-label={t("canvas.searchLabel")}
          placeholder={t("canvas.searchLabel")}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setLeftPage(0); setRightPage(0); }}
        />
        {groupsOf(data.outputs).length > 0 && (
          <label>
            {outputLabel}
            <select aria-label={t("canvas.outputGroupLabel")} value={rightGroup} onChange={(e) => { setRightGroup(e.target.value); setRightPage(0); }}>
              <option value="">{t("canvas.allGroups")}</option>
              {groupsOf(data.outputs).map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="graph">
        <span className="graph-caption">{`${t("canvas.inputColumn")} · ${leftFiltered.length}`}</span>
        <span className="graph-caption" style={{ left: "45%" }}>{t("canvas.gatewayColumn")}</span>
        <span className="graph-caption" style={{ right: 0 }}>{`${outputLabel} · ${rightFiltered.length}`}</span>
        <svg ref={svgRef} className="wires" viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
          {visibleLeft.map((n, i) => flowEdge(n, "left", yOf(i, visibleLeft.length), i))}
          {visibleRight.map((n, i) => flowEdge(n, "right", yOf(i, visibleRight.length), i))}
        </svg>
        {visibleLeft.map((n, i) => graphNode(n, "left", yOf(i, visibleLeft.length)))}
        {visibleRight.map((n, i) => graphNode(n, "right", yOf(i, visibleRight.length)))}
        <button
          type="button"
          className={`node gateway ${activeNodeId === "gateway" ? "chosen" : ""}`}
          aria-pressed={activeNodeId === "gateway"}
          onClick={() => setActiveNodeId("gateway")}
        >
          <span className="symbol" aria-hidden="true">LG</span>
          <span>
            <strong>LutraGate</strong>
            <small>{t("canvas.gatewaySubtitle")}</small>
          </span>
        </button>
        {leftFiltered.length === 0 && <span className="canvas-empty left">{t("canvas.emptyLeft")}</span>}
        {rightFiltered.length === 0 && <span className="canvas-empty right">{t("canvas.emptyRight")}</span>}
      </div>

      <div className="canvas-bottom">
        <SidePager
          side="left"
          outputLabel={outputLabel}
          page={leftPageClamped}
          total={leftFiltered.length}
          onDelta={(d) => { setLeftPage(leftPageClamped + d); setActiveNodeId("gateway"); }}
        />
        <span className="spacer" />
        <span className="graph-note">
          {t("canvas.scaleNote")}
          {reducedMotion && <span className="reduced-note"> · {t("canvas.reducedNote")}</span>}
        </span>
        <span className="spacer" />
        <SidePager
          side="right"
          outputLabel={outputLabel}
          page={rightPageClamped}
          total={rightFiltered.length}
          onDelta={(d) => { setRightPage(rightPageClamped + d); setActiveNodeId("gateway"); }}
        />
      </div>
      {/* 无障碍：动效状态可读（暂停开关已有 aria-pressed）。 */}
      <span className="visually-hidden" aria-live="polite">{noMotion ? t("canvas.pause") : ""}</span>
    </section>

    {/* 详情条是画布的兄弟节点（demo 同构）：嵌进 .graph-shell 会被排到画布
        顶部与 .graph-top 重叠——graph-shell 内其余子元素均为绝对定位。 */}
    <div className="node-detail panel-card">
        <div>
          <h3>{selected === null ? "LutraGate" : displayName(selected)}</h3>
          <p>
            {selected === null
              ? t("canvas.gatewayDetail")
              : `${selected.group === "" ? "" : `${selected.group} · `}${t("canvas.requests", { count: selected.count })}`}
          </p>
        </div>
        <div className="spacer" />
        {selected === null ? (
          <>
            <div className="detail-stat">
              {t("canvas.sevenDayRequests")}
              <strong>{data.gateway.total}</strong>
            </div>
            <div className="detail-stat">
              {t("canvas.successRate")}
              <strong>
                {data.gateway.successRate === null ? "—" : `${(data.gateway.successRate * 100).toFixed(1)}%`}
              </strong>
            </div>
          </>
        ) : (
          <span className={`muted tiny ${selected.failed > 0 ? "amber" : ""}`}>
            {selected.failed > 0
              ? t("canvas.failedHistory", { count: selected.failed })
              : t("canvas.noFailures")}
          </span>
        )}
        {onViewLogs && (
          <button type="button" className="small" onClick={onViewLogs}>
            {t("canvas.viewLogs")}
          </button>
        )}
    </div>
    </>
  );
}

function SidePager({
  side,
  outputLabel,
  page,
  total,
  onDelta,
}: {
  side: "left" | "right";
  /** 出口侧列名（供应商/模型，随画布 variant）。 */
  outputLabel: string;
  page: number;
  total: number;
  onDelta: (delta: number) => void;
}) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / PER_SIDE));
  const sideLabel = side === "left" ? t("canvas.inputColumn") : outputLabel;
  return (
    <div className="side-pager">
      <button
        type="button"
        className="small"
        disabled={page === 0}
        aria-label={`${sideLabel} ${t("canvas.prevPage")}`}
        onClick={() => onDelta(-1)}
      >
        ‹
      </button>
      <span>{total === 0 ? `0 / 0` : `${page * PER_SIDE + 1}–${Math.min(total, (page + 1) * PER_SIDE)} / ${total}`}</span>
      <button
        type="button"
        className="small"
        disabled={page >= pages - 1}
        aria-label={`${sideLabel} ${t("canvas.nextPage")}`}
        onClick={() => onDelta(1)}
      >
        ›
      </button>
    </div>
  );
}
