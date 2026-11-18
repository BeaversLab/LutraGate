import { describe, expect, it } from "vitest";
import type { LogRow } from "./api";
import {
  buildAdminCanvas,
  buildPersonalCanvas,
  DELETED_KEY_NODE_ID,
  NO_PROVIDER_NODE_ID,
  SEVEN_DAYS_MS,
  type CanvasKeySource,
  type CanvasNode,
  type CanvasProviderSource,
} from "./canvas-aggregate";

const NOW = 1_700_000_000_000;

const KEYS: CanvasKeySource[] = [
  { id: "ak-1", name: "日常编码", group: "alice" },
  { id: "ak-2", name: "家庭共享", group: "alice" },
];

const PROVIDERS: CanvasProviderSource[] = [
  { id: "p-zhipu", name: "智谱 AI", group: "智谱" },
  { id: "p-deep", name: "DeepSeek", group: "深度求索" },
];

/** 可控日志行：只给画布关心的字段，其余走契约默认。 */
function row(over: Partial<LogRow>): LogRow {
  return {
    id: over.id ?? "r",
    request_id: "req",
    ts: NOW - 1000,
    client_model: "m",
    upstream_model: null,
    provider_id: null,
    key_id: null,
    prompt_tokens: 0,
    completion_tokens: 0,
    latency_ms: 10,
    status: 200,
    error_type: null,
    user_id: null,
    access_key_id: null,
    ...over,
  };
}

const node = (nodes: CanvasNode[], id: string) => nodes.find((n) => n.id === id);

describe("buildAdminCanvas", () => {
  it("counts nodes, edges, and the gateway summary within the window", () => {
    const logs = [
      row({ id: "1", access_key_id: "ak-1", provider_id: "p-zhipu" }),
      row({ id: "2", access_key_id: "ak-1", provider_id: "p-zhipu" }),
      row({ id: "3", access_key_id: "ak-1", provider_id: "p-deep" }),
      row({ id: "4", access_key_id: "ak-2", provider_id: "p-deep", status: 502 }),
    ];
    const data = buildAdminCanvas(logs, KEYS, PROVIDERS, NOW, SEVEN_DAYS_MS);

    expect(node(data.inputs, "ak-1")).toMatchObject({ count: 3, failed: 0 });
    expect(node(data.inputs, "ak-2")).toMatchObject({ count: 1, failed: 1 });
    expect(node(data.outputs, "p-zhipu")).toMatchObject({ count: 2, failed: 0 });
    expect(node(data.outputs, "p-deep")).toMatchObject({ count: 2, failed: 1 });
    expect(data.edges).toContainEqual({ inputId: "ak-1", outputId: "p-zhipu", count: 2 });
    expect(data.edges).toContainEqual({ inputId: "ak-1", outputId: "p-deep", count: 1 });
    expect(data.edges).toContainEqual({ inputId: "ak-2", outputId: "p-deep", count: 1 });
    expect(data.gateway).toEqual({ total: 4, failed: 1, successRate: 0.75 });
  });

  it("drops rows outside the [now - windowMs, now] window", () => {
    const logs = [
      row({ id: "in", ts: NOW - SEVEN_DAYS_MS, access_key_id: "ak-1", provider_id: "p-zhipu" }),
      row({ id: "out", ts: NOW - SEVEN_DAYS_MS - 1, access_key_id: "ak-1", provider_id: "p-zhipu" }),
      row({ id: "future", ts: NOW + 1, access_key_id: "ak-1", provider_id: "p-zhipu" }),
    ];
    const data = buildAdminCanvas(logs, KEYS, PROVIDERS, NOW);
    expect(data.gateway.total).toBe(1);
    expect(data.edges).toEqual([{ inputId: "ak-1", outputId: "p-zhipu", count: 1 }]);
  });

  it("folds rows of deleted keys into the aggregated deleted node (story 7)", () => {
    const logs = [
      row({ id: "1", access_key_id: "ak-gone", provider_id: "p-zhipu" }),
      row({ id: "2", access_key_id: "ak-gone-2", provider_id: "p-deep", status: 500 }),
      row({ id: "3", access_key_id: "ak-1", provider_id: "p-zhipu" }),
    ];
    const data = buildAdminCanvas(logs, KEYS, PROVIDERS, NOW);
    const deleted = node(data.inputs, DELETED_KEY_NODE_ID);
    expect(deleted).toMatchObject({ count: 2, failed: 1 });
    // 已删 key 的流量不凭空消失：边照常聚合到聚合节点。
    expect(data.edges).toContainEqual({ inputId: DELETED_KEY_NODE_ID, outputId: "p-zhipu", count: 1 });
    expect(data.edges).toContainEqual({ inputId: DELETED_KEY_NODE_ID, outputId: "p-deep", count: 1 });
    // 无已删行时不出现聚合节点。
    const clean = buildAdminCanvas([logs[2]!], KEYS, PROVIDERS, NOW);
    expect(node(clean.inputs, DELETED_KEY_NODE_ID)).toBeUndefined();
  });

  it("folds rows with no provider into the no-channel output node", () => {
    const logs = [
      row({ id: "1", access_key_id: "ak-1", provider_id: null, status: 503 }),
      row({ id: "2", access_key_id: null, provider_id: null }),
    ];
    const data = buildAdminCanvas(logs, KEYS, PROVIDERS, NOW);
    const noChannel = node(data.outputs, NO_PROVIDER_NODE_ID);
    expect(noChannel).toMatchObject({ count: 2, failed: 1 });
    // 无归属（access_key_id 空）的历史行进总量，不产生边。
    expect(data.edges).toEqual([{ inputId: "ak-1", outputId: NO_PROVIDER_NODE_ID, count: 1 }]);
    expect(data.gateway.total).toBe(2);
  });

  it("keeps zero-traffic keys and providers visible without edges (story 8)", () => {
    const logs = [row({ id: "1", access_key_id: "ak-1", provider_id: "p-zhipu" })];
    const data = buildAdminCanvas(logs, KEYS, PROVIDERS, NOW);
    expect(node(data.inputs, "ak-2")).toMatchObject({ count: 0, failed: 0 });
    expect(node(data.outputs, "p-deep")).toMatchObject({ count: 0, failed: 0 });
    expect(data.edges).toHaveLength(1);
  });

  it("marks a node as warning only when it had failures in the window", () => {
    const logs = [
      row({ id: "ok", access_key_id: "ak-1", provider_id: "p-zhipu" }),
      row({ id: "401", access_key_id: "ak-2", provider_id: "p-zhipu", status: 401 }),
      row({ id: "429", access_key_id: "ak-2", provider_id: "p-deep", status: 429 }),
      row({ id: "302", access_key_id: "ak-2", provider_id: "p-deep", status: 302 }),
    ];
    const data = buildAdminCanvas(logs, KEYS, PROVIDERS, NOW);
    expect(node(data.inputs, "ak-1")!.failed).toBe(0);
    // 401/429 计失败（与仪表盘 isSuccessful 口径一致）；3xx 不计。
    expect(node(data.inputs, "ak-2")!.failed).toBe(2);
  });

  it("sorts nodes by request count desc, name asc for stable pagination", () => {
    const logs = [
      row({ id: "a", access_key_id: "ak-2", provider_id: "p-deep" }),
      row({ id: "b", access_key_id: "ak-1", provider_id: "p-deep" }),
      row({ id: "c", access_key_id: "ak-1", provider_id: "p-deep" }),
    ];
    const data = buildAdminCanvas(logs, KEYS, PROVIDERS, NOW);
    expect(data.inputs.map((n) => n.id)).toEqual(["ak-1", "ak-2"]);
  });

  it("returns an empty-but-valid canvas for no logs", () => {
    const data = buildAdminCanvas([], KEYS, PROVIDERS, NOW);
    expect(data.inputs.map((n) => n.id).sort()).toEqual(["ak-1", "ak-2"]);
    expect(data.outputs.map((n) => n.id).sort()).toEqual(["p-deep", "p-zhipu"]);
    expect(data.edges).toEqual([]);
    expect(data.gateway).toEqual({ total: 0, failed: 0, successRate: null });
  });
});

describe("buildPersonalCanvas", () => {
  const OWN = "u-me";

  it("keeps only the user's own rows — others' and unattributed history never leak (selfOnly)", () => {
    const logs = [
      row({ id: "mine", user_id: OWN, access_key_id: "ak-1", provider_id: "p-zhipu", upstream_model: "glm-4.6" }),
      row({ id: "other", user_id: "u-other", access_key_id: "ak-2", provider_id: "p-deep", upstream_model: "x" }),
      row({ id: "legacy", user_id: null, access_key_id: "ak-1", provider_id: "p-zhipu", upstream_model: "y" }),
    ];
    const data = buildPersonalCanvas(logs, KEYS, OWN, NOW);
    expect(data.gateway.total).toBe(1);
    expect(node(data.inputs, "ak-1")).toMatchObject({ count: 1 });
    expect(node(data.inputs, "ak-2")).toMatchObject({ count: 0 });
    // 他人流量去向（供应商 x/y）不出现在出口节点。
    expect(data.outputs.map((n) => n.name)).toEqual(["glm-4.6"]);
  });

  it("uses upstream_model with client_model fallback as the output node", () => {
    const logs = [
      row({ id: "up", user_id: OWN, access_key_id: "ak-1", provider_id: "p-zhipu", upstream_model: "glm-4.6", client_model: "claude-sonnet-4-5" }),
      row({ id: "fall", user_id: OWN, access_key_id: "ak-1", provider_id: "p-zhipu", upstream_model: null, client_model: "deepseek-chat" }),
    ];
    const data = buildPersonalCanvas(logs, KEYS, OWN, NOW);
    expect(data.outputs.map((n) => n.name).sort()).toEqual(["deepseek-chat", "glm-4.6"]);
    expect(node(data.outputs, "glm-4.6")).toMatchObject({ count: 1 });
    expect(node(data.outputs, "deepseek-chat")).toMatchObject({ count: 1 });
    // 不携带供应商信息：节点即模型名，provider id 不外显。
    expect(data.outputs.every((n) => n.name.startsWith("p-") === false)).toBe(true);
  });

  it("folds own deleted keys into the aggregate and keeps zero-traffic own keys visible", () => {
    const logs = [
      row({ id: "1", user_id: OWN, access_key_id: "ak-gone", provider_id: "p-zhipu", upstream_model: "glm-4.6" }),
      row({ id: "2", user_id: "u-other", access_key_id: "ak-gone", provider_id: "p-deep", upstream_model: "x" }),
    ];
    const data = buildPersonalCanvas(logs, KEYS, OWN, NOW);
    expect(node(data.inputs, DELETED_KEY_NODE_ID)).toMatchObject({ count: 1 });
    expect(node(data.inputs, "ak-1")).toMatchObject({ count: 0 });
    expect(data.gateway.total).toBe(1);
  });
});
