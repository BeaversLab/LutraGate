/**
 * 管理总览画布聚合纯函数（UI 2.0 #12，spec「画布聚合纯模块」）：
 * 本地镜像 LogRow × {访问 Key, 供应商} → 入口/出口节点、带 7 天请求计数的边、
 * 网关汇总、失败告警标记。与 lib/aggregate.ts 同构同层；SVG 连线几何与动效
 * 不进本模块（测试面 = 纯函数输出）。
 */

import type { LogRow } from "./api";
import { isSuccessful } from "./aggregate";

export const SEVEN_DAYS_MS = 7 * 86_400_000;

/** 已删访问 Key 的历史行归并到的聚合节点 id（spec 故事 7：历史流量不凭空消失）。 */
export const DELETED_KEY_NODE_ID = "__deleted_keys__";
/** provider_id 为空（NO_CHANNEL 等未出网关路径）的行归并到的出口聚合节点 id。 */
export const NO_PROVIDER_NODE_ID = "__no_provider__";

/** 入口节点数据源：现存访问 Key（group = 归属用户名等展示分组）。 */
export interface CanvasKeySource {
  id: string;
  name: string;
  group: string;
}

/** 出口节点数据源：供应商（group = 厂商等展示分组）。 */
export interface CanvasProviderSource {
  id: string;
  name: string;
  group: string;
}

/** 画布节点：count = 窗口内请求数（0 = 零流量，显示但无连线）；failed > 0 → 橙色告警
 * （历史告警非实时健康，spec 故事 5）。 */
export interface CanvasNode {
  id: string;
  name: string;
  group: string;
  count: number;
  failed: number;
}

/** 边：入口节点 id × 出口节点 id 的窗口内请求数；两端必须是真实节点
 * （未归属入口的历史行计入出口/网关总量但不产生边）。 */
export interface CanvasEdge {
  inputId: string;
  outputId: string;
  count: number;
}

/** 网关节点汇总（7 天口径）。 */
export interface GatewaySummary {
  total: number;
  failed: number;
  successRate: number | null;
}

export interface AdminCanvasData {
  /** 入口 = 现存访问 Key（零流量也显示）+ 可选「已删除」聚合节点；按请求量降序。 */
  inputs: CanvasNode[];
  /** 出口 = 全部供应商（零流量也显示）+ 可选「（无渠道）」聚合节点；按请求量降序。 */
  outputs: CanvasNode[];
  edges: CanvasEdge[];
  gateway: GatewaySummary;
}

interface Bucket {
  count: number;
  failed: number;
}

function emptyBucket(): Bucket {
  return { count: 0, failed: 0 };
}

/**
 * 聚合规则：
 * - 窗口 = [now - windowMs, now]（含端点）；
 * - 失败口径与仪表盘一致（isSuccessful：5xx / 401 / 429 为失败）；
 * - access_key_id 指向已删 key 的行归「已删除」聚合节点；为空（历史行）计入
 *   网关与出口总量但不产生边与入口节点；
 * - provider_id 为空的行归「（无渠道）」出口聚合节点；
 * - 节点按请求量降序（同量按名称），分页/筛选在展示层做。
 */
export function buildAdminCanvas(
  logs: LogRow[],
  keys: CanvasKeySource[],
  providers: CanvasProviderSource[],
  now: number,
  windowMs: number = SEVEN_DAYS_MS,
): AdminCanvasData {
  const from = now - windowMs;
  const inputStats = new Map<string, Bucket>();
  const outputStats = new Map<string, Bucket>();
  const edgeStats = new Map<string, number>();
  const keyIds = new Set(keys.map((k) => k.id));
  const providerIds = new Set(providers.map((p) => p.id));

  let total = 0;
  let failedTotal = 0;
  for (const log of logs) {
    if (log.ts < from || log.ts > now) continue;
    total += 1;
    const failed = isSuccessful(log) ? 0 : 1;
    failedTotal += failed;

    // 入口归并：已知 key → 节点；已删 key → 聚合节点；无归属 → 只进总量。
    let inputId: string | null = null;
    if (log.access_key_id !== null) {
      inputId = keyIds.has(log.access_key_id) ? log.access_key_id : DELETED_KEY_NODE_ID;
      const bucket = inputStats.get(inputId) ?? emptyBucket();
      bucket.count += 1;
      bucket.failed += failed;
      inputStats.set(inputId, bucket);
    }

    // 出口归并：已知供应商 → 节点；其余（含 null）→ 「无渠道」聚合节点。
    const outputId = log.provider_id !== null && providerIds.has(log.provider_id)
      ? log.provider_id
      : NO_PROVIDER_NODE_ID;
    const outBucket = outputStats.get(outputId) ?? emptyBucket();
    outBucket.count += 1;
    outBucket.failed += failed;
    outputStats.set(outputId, outBucket);

    if (inputId !== null) {
      const edgeKey = `${inputId}\u0000${outputId}`;
      edgeStats.set(edgeKey, (edgeStats.get(edgeKey) ?? 0) + 1);
    }
  }

  const toNode = (
    id: string,
    name: string,
    group: string,
    stats: Map<string, Bucket>,
  ): CanvasNode => {
    const bucket = stats.get(id) ?? emptyBucket();
    return { id, name, group, count: bucket.count, failed: bucket.failed };
  };

  const inputs: CanvasNode[] = keys.map((k) => toNode(k.id, k.name, k.group, inputStats));
  if (inputStats.has(DELETED_KEY_NODE_ID)) {
    inputs.push(toNode(DELETED_KEY_NODE_ID, "__deleted__", "", inputStats));
  }
  const outputs: CanvasNode[] = providers.map((p) => toNode(p.id, p.name, p.group, outputStats));
  if (outputStats.has(NO_PROVIDER_NODE_ID)) {
    outputs.push(toNode(NO_PROVIDER_NODE_ID, "__no_provider__", "", outputStats));
  }

  const byCountDesc = (a: CanvasNode, b: CanvasNode) => b.count - a.count || a.name.localeCompare(b.name);
  return {
    inputs: inputs.sort(byCountDesc),
    outputs: outputs.sort(byCountDesc),
    edges: [...edgeStats.entries()].map(([key, count]) => {
      const [inputId, outputId] = key.split("\u0000");
      return { inputId: inputId!, outputId: outputId!, count };
    }),
    gateway: {
      total,
      failed: failedTotal,
      successRate: total === 0 ? null : (total - failedTotal) / total,
    },
  };
}

/**
 * 个人调用路径画布聚合（UI 2.0 #13）：入口 = 自己的访问 Key，出口 = 上游模型
 * （upstream_model，空回退 client_model）——user 角色无供应商列表权限，不以
 * 供应商为节点、不携带供应商信息。selfOnly 语义钉在数据层：只统计
 * user_id === userId 的行（administrator 切个人视角时本地镜像含全量行，靠此
 * 过滤不越权；user_id 为空的历史行不属于任何人，同样排除）。网关汇总 =
 * 自己的 7 天口径。
 */
export function buildPersonalCanvas(
  logs: LogRow[],
  keys: CanvasKeySource[],
  userId: string,
  now: number,
  windowMs: number = SEVEN_DAYS_MS,
): AdminCanvasData {
  const own = logs.filter((l) => l.user_id === userId);
  // 出口 = 模型名（upstream_model 回退 client_model；client_model 恒有值）。
  // 复用 buildAdminCanvas 的全部聚合语义：把 provider_id 重映射为模型名即可，
  // 已删 key 聚合/零流量/边计数/网关口径都不用重写。
  const models = new Map<string, CanvasProviderSource>();
  const remapped: LogRow[] = own.map((l) => {
    const model = l.upstream_model ?? l.client_model;
    if (!models.has(model)) models.set(model, { id: model, name: model, group: "" });
    return { ...l, provider_id: model };
  });
  return buildAdminCanvas(remapped, keys, [...models.values()], now, windowMs);
}
