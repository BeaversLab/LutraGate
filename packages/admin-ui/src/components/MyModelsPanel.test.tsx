import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AdminApi } from "../lib/api";
import { MyModelsPanel } from "./MyModelsPanel";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function makeApi(payload?: { grants?: unknown[]; models?: string[] }) {
  return new AdminApi({
    baseUrl: "http://gw.test",
    adminToken: "t",
    fetcher: async (url) => {
      expect(url).toBe("http://gw.test/admin/me/grants");
      return jsonResponse({
        user_id: "u2",
        grants: payload?.grants ?? [
          { id: "g1", provider_key_id: "k1", provider_id: "p1", provider_name: "deepseek", key_hint: "aa01", created_at: 1 },
        ],
        models: payload?.models ?? ["gpt-4o", "deepseek-chat"],
      });
    },
  });
}

/** 打开一行连接方式 aside（打磨轮：行尾「连接方式」按钮 → DetailAside）。 */
async function openConnect(model: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`查看 ${model} 的连接方式`) }));
  await screen.findByRole("complementary");
}

describe("MyModelsPanel (multi-user 07, split #19; 打磨轮连接方式升级)", () => {
  it("renders the read-only reachable models and granted upstream keys", async () => {
    render(<MyModelsPanel api={makeApi()} baseUrl="http://gw.test" />);

    // 可达模型只读列表（与 /v1/models 同一收敛结果）。
    expect(await screen.findByText("gpt-4o")).toBeTruthy();
    expect(screen.getByText("deepseek-chat")).toBeTruthy();
    // 被分配的供应商与 key 尾号可见；无任何编辑入口。
    expect(screen.getByText("deepseek")).toBeTruthy();
    expect(screen.getByText(/aa01/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /创建|保存|删除/ })).toBeNull();
  });

  it("aside shows connection info (model / gateway /v1 base URL / lgk_ placeholder) + copyable curl example", async () => {
    render(<MyModelsPanel api={makeApi()} baseUrl="http://gw.test/" />);
    await openConnect("gpt-4o");

    const aside = await screen.findByRole("complementary");
    expect(aside.textContent).toContain("gpt-4o");
    // 网关地址 = 当前环境地址（去尾斜杠）+ /v1。
    expect(screen.getByText("http://gw.test/v1")).toBeTruthy();
    // API Key 只给占位，绝不展示/复制真实凭证。
    expect(screen.getAllByText("YOUR_ACCESS_KEY").length).toBeGreaterThan(0);
    expect(aside.textContent).toContain("lgk_");
    // 接入示例：三件套拼好的 curl（占位 Key），复制改一词即可跑通第一个请求。
    expect(aside.textContent).toContain(`curl http://gw.test/v1/chat/completions`);
    expect(aside.textContent).toContain(`'{"model":"gpt-4o"`);
  });

  it("filters models by search and collapses the aside when the selected row is filtered out", async () => {
    render(<MyModelsPanel api={makeApi()} baseUrl="http://gw.test" />);
    await openConnect("gpt-4o");
    expect(await screen.findByRole("complementary")).toBeTruthy();

    // 搜索把选中行筛掉 → aside 收起。
    fireEvent.change(screen.getByLabelText("搜索模型 ID"), { target: { value: "deepseek" } });
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getByText("deepseek-chat")).toBeTruthy();
    expect(screen.queryByText("gpt-4o")).toBeNull();

    // 无匹配 → 空态分「没有匹配的模型」。
    fireEvent.change(screen.getByLabelText("搜索模型 ID"), { target: { value: "nope" } });
    expect(screen.getByText("没有匹配的模型")).toBeTruthy();
  });

  it("copy buttons write model ID, base URL and the full curl example to the clipboard", async () => {
    const writes: string[] = [];
    Object.assign(navigator, {
      clipboard: { writeText: async (text: string) => { writes.push(text); } },
    });
    render(<MyModelsPanel api={makeApi()} baseUrl="http://gw.test" />);
    await openConnect("deepseek-chat");
    fireEvent.click(await screen.findByRole("button", { name: "复制模型 ID" }));
    expect(await screen.findByText("已复制")).toBeTruthy(); // 复制反馈（同 OneTimeSecret 手法）
    fireEvent.click(screen.getByRole("button", { name: "复制 Base URL" }));
    fireEvent.click(screen.getByRole("button", { name: "复制 curl 示例" }));
    expect(writes).toEqual([
      "deepseek-chat",
      "http://gw.test/v1",
      expect.stringContaining(`curl http://gw.test/v1/chat/completions`),
    ]);
    expect(writes[2]).toContain("-H \"Authorization: Bearer YOUR_ACCESS_KEY\"");
    expect(writes[2]).toContain(`'{"model":"deepseek-chat"`);
  });

  it("shows a single empty state when no upstream keys are granted (no duplicated sections)", async () => {
    render(<MyModelsPanel api={makeApi({ grants: [], models: [] })} baseUrl="http://gw.test" />);
    expect(await screen.findByText(/还没有被分配任何上游 Key/)).toBeTruthy();
    // 不再渲染「已授权的模型 / 被分配的上游 Key」两区块各自空。
    expect(screen.queryByText("已授权的模型")).toBeNull();
    expect(screen.queryByText("被分配的上游 Key")).toBeNull();
  });
});
