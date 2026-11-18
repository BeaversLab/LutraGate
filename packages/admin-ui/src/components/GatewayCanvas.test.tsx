import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GatewayCanvas } from "./GatewayCanvas";
import { buildAdminCanvas, DELETED_KEY_NODE_ID } from "../lib/canvas-aggregate";

import type { LogRow } from "../lib/api";

const NOW = 1_700_000_000_000;

/** 组装画布数据走真实聚合函数（组件测试只测展示行为，聚合正确性另有单测）。 */
function data(logs: Array<Partial<LogRow>>, keyCount = 2, providerCount = 2) {
  return buildAdminCanvas(
    logs.map((over) => ({
      id: "r",
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
    })),
    Array.from({ length: keyCount }, (_, i) => ({
      id: `ak-${i + 1}`,
      name: `场景${i + 1}`,
      group: i === 0 ? "开发" : "家庭",
    })),
    Array.from({ length: providerCount }, (_, i) => ({
      id: `p-${i + 1}`,
      name: `供应商${i + 1}`,
      group: "通用",
    })),
    NOW,
  );
}

const sideNodes = (side: string) => screen.queryAllByTestId(`node-${side}`);

describe("GatewayCanvas", () => {
  it("renders three columns: input nodes, the gateway node, output nodes", () => {
    render(
      <GatewayCanvas
        data={data([
          { id: "1", access_key_id: "ak-1", provider_id: "p-1" },
          { id: "2", access_key_id: "ak-2", provider_id: "p-2", status: 500 },
        ])}
      />,
    );
    expect(sideNodes("left")).toHaveLength(2);
    expect(sideNodes("right")).toHaveLength(2);
    expect(screen.getByText("LutraGate", { selector: ".node.gateway strong" })).toBeTruthy();
    // 节点小字含 7 天请求计数与失败告警。
    expect(sideNodes("left")[0]!.textContent).toContain("1 次请求");
    expect(sideNodes("left")[1]!.textContent).toContain("1 次历史失败");
    // 失败节点带橙色告警标记类。
    expect(sideNodes("left")[1]!.className).toContain("warn");
  });

  it("selecting a node updates the detail bar and aria-pressed; gateway resets", () => {
    render(<GatewayCanvas data={data([{ id: "1", access_key_id: "ak-1", provider_id: "p-1" }])} />);
    // 默认网关态：详情条给 7 天总量与成功率。
    expect(screen.getByText("近 7 天请求", { selector: ".node-detail .detail-stat" })).toBeTruthy();
    const input = screen.getAllByTestId("node-left")[0]!;
    fireEvent.click(input);
    expect(input.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/^场景1$/, { selector: ".node-detail h3" })).toBeTruthy(); // 详情条标题
    expect(screen.getByText(/1 次请求/, { selector: ".node-detail p" })).toBeTruthy();
    // 点回网关：详情条复位。
    fireEvent.click(screen.getByRole("button", { name: /加权路由/ }));
    expect(screen.getByText("近 7 天请求", { selector: ".node-detail .detail-stat" })).toBeTruthy();
  });

  it("paginates each side at 6 nodes and resets selection on page change", () => {
    const d = data(
      Array.from({ length: 7 }, (_, i) => ({ id: String(i), access_key_id: `ak-${i + 1}`, provider_id: "p-1" })),
      7,
    );
    render(<GatewayCanvas data={d} />);
    expect(sideNodes("left")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "入口场景 下一页" }));
    expect(sideNodes("left")).toHaveLength(1);
    // 翻页回网关选中态（demo 行为：分页不代表停用）。
    expect(screen.getByRole("button", { name: /加权路由/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "入口场景 上一页" }));
    expect(sideNodes("left")).toHaveLength(6);
  });

  it("filters nodes by name search and by group", () => {
    render(
      <GatewayCanvas
        data={data([
          { id: "1", access_key_id: "ak-1", provider_id: "p-1" },
          { id: "2", access_key_id: "ak-2", provider_id: "p-2" },
        ])}
      />,
    );
    // 搜索同时作用于两侧（demo：一个搜索框匹配入口与出口）。
    fireEvent.change(screen.getByLabelText("搜索节点名称"), { target: { value: "场景2" } });
    expect(sideNodes("left")).toHaveLength(1);
    expect(sideNodes("right")).toHaveLength(0);
    expect(screen.getByText("无匹配出口")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("搜索节点名称"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("入口分组"), { target: { value: "开发" } });
    expect(sideNodes("left")).toHaveLength(1);
    expect(sideNodes("left")[0]!.textContent).toContain("场景1");
    // 无匹配侧显示空态。
    fireEvent.change(screen.getByLabelText("入口分组"), { target: { value: "家庭" } });
    fireEvent.change(screen.getByLabelText("搜索节点名称"), { target: { value: "场景1" } });
    expect(screen.getByText("无匹配入口")).toBeTruthy();
  });

  it("shows the deleted-keys aggregate node with its historical traffic", () => {
    render(
      <GatewayCanvas
        data={data([{ id: "1", access_key_id: "ak-gone", provider_id: "p-1" }])}
      />,
    );
    const deleted = sideNodes("left").find((n) => n.textContent!.includes("已删除"));
    expect(deleted).toBeTruthy();
    expect(deleted!.textContent).toContain("1 次请求");
    // 聚合哨兵 id 不外显（展示名 = 已删除）。
    expect(document.body.textContent).not.toContain(DELETED_KEY_NODE_ID);
  });

  it("draws no edge for zero-traffic nodes (story 8: visible but unconnected)", () => {
    const { container } = render(
      <GatewayCanvas data={data([{ id: "1", access_key_id: "ak-1", provider_id: "p-1" }])} />,
    );
    // 两个入口节点都在，但只有有流量的那条边。
    expect(sideNodes("left")).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid^="edge-left-"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="edge-left-0"]')!.textContent).toContain("1");
  });

  it("toggles flow pause and honors reduced motion (no SMIL dots)", () => {
    // 带一条有流量的日志，画布才有连线与光点可停。
    const withFlow = data([{ id: "1", access_key_id: "ak-1", provider_id: "p-1" }]);
    const { container, rerender } = render(<GatewayCanvas data={withFlow} />);
    expect(container.querySelectorAll("animateMotion").length).toBeGreaterThan(0);
    const pause = screen.getByRole("button", { name: "暂停流动" });
    fireEvent.click(pause);
    expect(screen.getByRole("button", { name: "播放流动" }).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".flow-canvas")!.className).toContain("flow-paused");
    // reducedMotion：不渲染 SMIL 光点，并显示静态说明。
    rerender(<GatewayCanvas data={withFlow} reducedMotion />);
    expect(container.querySelectorAll("animateMotion")).toHaveLength(0);
    expect(screen.getByText(/已遵循减少动态效果设置/)).toBeTruthy();
  });

  it("surfaces the view-logs action to the shell", () => {
    const onViewLogs = vi.fn();
    render(<GatewayCanvas data={data([])} onViewLogs={onViewLogs} />);
    fireEvent.click(screen.getByRole("button", { name: "查看请求日志" }));
    expect(onViewLogs).toHaveBeenCalledTimes(1);
  });

  it("renders the personal-variant title for the my-overview canvas (#13)", () => {
    render(<GatewayCanvas data={data([])} variant="personal" />);
    expect(screen.getByRole("heading", { name: "我的调用路径" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "网关流量图" })).toBeNull();
    // 出口列标注换为「出口模型」（列题注与分页 aria 同步换词）。
    expect(screen.getByText("出口模型 · 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "出口模型 上一页" })).toBeTruthy();
  });

  it("hides the group selects when nodes carry no groups (personal models have none)", () => {
    const groupless = buildAdminCanvas(
      [],
      [{ id: "ak-1", name: "我的 key", group: "" }],
      [{ id: "m-1", name: "glm-4.6", group: "" }],
      1,
    );
    render(<GatewayCanvas data={groupless} variant="personal" />);
    expect(screen.queryByLabelText("入口分组")).toBeNull();
    expect(screen.queryByLabelText("出口分组")).toBeNull();
    expect(screen.getByText("出口模型 · 1")).toBeTruthy();
  });
});
