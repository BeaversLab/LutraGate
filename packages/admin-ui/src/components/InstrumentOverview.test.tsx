import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { InstrumentOverview } from "./InstrumentOverview";
import type { AdminApi, LogRow } from "../lib/api";
import type { LogStore } from "../lib/logstore";
vi.mock("../hooks/useLogSync", () => ({ useLogSync: () => ({ busy: false, lastSyncAt: null, error: null, syncNow: vi.fn() }) }));
const now = Date.now();
const logs: LogRow[] = Array.from({ length: 100 }, (_, i) => ({ id: String(i), request_id: String(i), ts: now - 1000, client_model: "coding", upstream_model: null, provider_id: i < 90 ? "a" : i < 98 ? "b" : null, key_id: null, prompt_tokens: null, completion_tokens: null, latency_ms: null, status: i < 98 ? 200 : 503, error_type: i < 98 ? null : "NO_CHANNEL", user_id: "u", access_key_id: "k" }));
const api = { listProviders: async () => [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }], listAccessKeys: async () => [{ id: "k", name: "编码", user_id: "u", key_hint: "abcd" }], listUsers: async () => [{ id: "u", name: "Marco" }] } as unknown as AdminApi;
const db = { listLogs: async () => logs } as unknown as LogStore;
describe("instrument overview", () => {
  it("uses exact shares and filters the evidence through the failure popover", async () => {
    const viewLogs = vi.fn();
    const { container } = render(<InstrumentOverview api={api} db={db} onViewLogs={viewLogs} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Alpha 90.0%" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Alpha 90.0%" }).getAttribute("stroke-dasharray")).toBe("90 10");
    expect(screen.getByRole("button", { name: "Beta 8.0%" }).getAttribute("stroke-dasharray")).toBe("8 92");
    fireEvent.click(screen.getByRole("button", { name: "未能转发 2.0%" }));
    expect(screen.getByRole("dialog", { name: "未能转发" })).toBeTruthy();
    expect(container.querySelectorAll(".io-recent tbody tr")).toHaveLength(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(container.querySelectorAll(".io-recent tbody tr")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "查看全部日志 →" }));
    expect(viewLogs).toHaveBeenCalledOnce();
  });
  it("supports hourly and custom ranges, rejecting reversed dates", async () => {
    const read = vi.fn(async () => logs);
    render(<InstrumentOverview api={api} db={{ listLogs: read } as unknown as LogStore} />);
    await screen.findByRole("button", { name: "Alpha 90.0%" });
    fireEvent.change(screen.getByLabelText("统计时间范围"), { target: { value: "24h" } });
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(1));
    fireEvent.change(screen.getByLabelText("统计时间范围"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "2026-01-02T00:00" } });
    fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "2026-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "应用范围" }));
    expect(screen.getByRole("alert").textContent).toContain("结束时间须晚于开始时间");
    fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "2026-01-03T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "应用范围" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() => expect(read).toHaveBeenLastCalledWith(new Date("2026-01-02T00:00").getTime(), new Date("2026-01-03T00:00").getTime()));
  });

  it("switches the outer ring to known token shares and pauses direction animation", async () => {
    const usageLogs = logs.map((l, i) => ({ ...l, prompt_tokens: i === 0 ? 100 : i === 90 ? 300 : null, completion_tokens: i === 0 ? 100 : i === 90 ? 500 : null }));
    const { container } = render(<InstrumentOverview api={api} db={{ listLogs: async () => usageLogs } as unknown as LogStore} />);
    await screen.findByRole("button", { name: "Alpha 90.0%" });
    expect(container.querySelector(".io-flow-running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "暂停流动" }));
    expect(container.querySelector(".io-flow-paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Token 用量" }));
    expect(screen.getByRole("button", { name: "Alpha 20.0%" }).getAttribute("stroke-dasharray")).toBe("20 80");
    expect(screen.getByRole("button", { name: "Beta 80.0%" }).getAttribute("stroke-dasharray")).toBe("80 20");
    expect(screen.getAllByRole("columnheader", { name: "输入 Token" })).toHaveLength(1);
    expect(screen.getByRole("columnheader", { name: "输出 Token" })).toBeTruthy();
  });

  it("scopes a mixed mirror to the personal user without requesting administrator lists", async () => {
    const personalApi = { listAccessKeys: vi.fn(async () => [{ id: "k", name: "我的场景", user_id: "u", key_hint: "abcd" }, { id: "other", name: "其他人的场景", user_id: "other" }]), listProviders: vi.fn(), listUsers: vi.fn() };
    const mixed = [...logs, { ...logs[0]!, id: "other", user_id: "other", client_model: "private-other-model" }];
    const { container } = render(<InstrumentOverview api={personalApi as unknown as AdminApi} db={{ listLogs: async () => mixed } as unknown as LogStore} identity={{ id: "u", name: "Marco", role: "administrator" }} />);
    await screen.findByRole("button", { name: "coding 98.0%" });
    expect(screen.getByRole("heading", { name: "我的总览" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader", { name: "模型" })).toHaveLength(2);
    expect(container.textContent).not.toContain("private-other-model");
    expect(container.textContent).not.toContain("其他人的场景");
    expect(personalApi.listProviders).not.toHaveBeenCalled();
    expect(personalApi.listUsers).not.toHaveBeenCalled();
  });

});
