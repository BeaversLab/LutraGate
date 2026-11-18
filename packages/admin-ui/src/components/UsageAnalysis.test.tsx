import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UsageAnalysis } from "./UsageAnalysis";
import type { AdminApi, LogRow } from "../lib/api";
import type { LogStore } from "../lib/logstore";
vi.mock("../hooks/useLogSync", () => ({ useLogSync: () => ({ busy: false, lastSyncAt: null, error: null, syncNow: vi.fn() }) }));
const now = Date.now();
const base = { upstream_model: null, key_id: null, latency_ms: 120, user_id: "u", access_key_id: "k", provider_id: "p", error_type: null };
const logs = [{ ...base, id: "1", request_id: "1", ts: now - 1000, client_model: "model-a", prompt_tokens: 100, completion_tokens: 20, status: 200 }, { ...base, id: "2", request_id: "2", ts: now - 2000, client_model: "model-b", prompt_tokens: 200, completion_tokens: 30, status: 500 }] as LogRow[];
const api = { listProviders: async () => [{ id: "p", name: "Provider" }], listUsers: async () => [{ id: "u", name: "Marco" }], listAccessKeys: async () => [{ id: "k", name: "编码" }] } as unknown as AdminApi;
const db = { listLogs: async () => logs } as unknown as LogStore;
describe("usage analysis", () => {
  it("inherits exact time and object filters and supports combined model and outcome filters", async () => {
    const back = vi.fn();
    const { container } = render(<UsageAnalysis api={api} db={db} context={{ from: now - 1500, to: now, key: "k", provider: "p" }} onBack={back} />);
    await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(1));
    expect(screen.getByLabelText("分析供应商")).toHaveProperty("value", "p");
    expect(container.querySelector("tbody")!.textContent).toContain("model-a");
    expect(container.querySelector("tbody")!.textContent).not.toContain("model-b");
    fireEvent.change(screen.getByLabelText("分析结果"), { target: { value: "failed" } });
    expect(screen.getByText("当前筛选范围暂无请求。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    fireEvent.click(screen.getByRole("button", { name: "用户用量" }));
    expect(container.querySelector("tbody")!.textContent).toContain("Marco");
    fireEvent.click(screen.getByRole("button", { name: "延迟分析" }));
    expect(screen.getByRole("columnheader", { name: "P95" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← 返回总览" }));
    expect(back).toHaveBeenCalledOnce();
  });
  it("keeps personal analysis and export source scoped to self without admin endpoints", async () => {
    const personalApi = { listAccessKeys: vi.fn(async () => [{ id: "k", name: "编码", user_id: "u" }]), listProviders: vi.fn(), listUsers: vi.fn() };
    const { container } = render(<UsageAnalysis api={personalApi as unknown as AdminApi} db={{ listLogs: async () => [...logs, { ...logs[0], id: "secret", user_id: "other", client_model: "private-model" }] } as unknown as LogStore} identity={{ id: "u", name: "Marco", role: "user" }} onBack={vi.fn()} />);
    await waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    expect(screen.getByRole("heading", { name: "我的用量分析" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "用户用量" })).toBeNull();
    expect(screen.queryByLabelText("分析用户")).toBeNull();
    expect(container.textContent).not.toContain("private-model");
    expect(personalApi.listProviders).not.toHaveBeenCalled();
    expect(personalApi.listUsers).not.toHaveBeenCalled();
  });

});
