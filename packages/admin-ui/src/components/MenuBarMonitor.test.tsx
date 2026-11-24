import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { AdminApi, type AccessKeyRow, type Identity, type UsageRow } from "../lib/api";
import { MENU_TICK_EVENT } from "../lib/menu-bar";
import { MenuBarMonitor } from "./MenuBarMonitor";

const IDENTITY: Identity = { id: "u1", name: "alice", role: "administrator" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const KEYS: AccessKeyRow[] = [{
  id: "ak1",
  user_id: "u1",
  name: "场景",
  key_hint: "abcd",
  enabled: true,
  daily_token_limit: 100,
  daily_request_limit: 0,
  max_concurrency: 0,
  expires_at: 0,
  ip_allowlist: [],
  created_at: 1,
  updated_at: 1,
}];

function usageRow(tokens: number): UsageRow {
  return {
    access_key_id: "ak1",
    requests: 1,
    errors: 0,
    prompt_tokens: tokens,
    completion_tokens: 0,
    avg_latency_ms: 1,
  };
}

let invoke: ReturnType<typeof vi.fn>;

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

beforeEach(() => {
  window.localStorage.clear();
  invoke = vi.fn(() => Promise.resolve());
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
});

function titleCalls(): unknown[][] {
  return invoke.mock.calls.filter(([cmd]) => cmd === "set_tray_title");
}

function monitorApi(usageFor: (call: number) => Response): { api: AdminApi; usageCalls: () => number } {
  let usageCall = 0;
  const api = new AdminApi({
    baseUrl: "http://gw.test",
    adminToken: "t",
    fetcher: async (url) => {
      if (url.includes("/admin/access-keys")) return jsonResponse(KEYS);
      if (url.includes("/admin/usage")) {
        usageCall++;
        return usageFor(usageCall);
      }
      return jsonResponse({});
    },
  });
  return { api, usageCalls: () => usageCall };
}

describe("MenuBarMonitor (menu-bar-usage 06)", () => {
  it("polls on mount and on the Rust tick, updating the tray title", async () => {
    let tokenUsage = 95;
    const { api } = monitorApi(() => jsonResponse({ group_by: "key", window_start: 1, usage: [usageRow(tokenUsage)] }));
    render(<MenuBarMonitor api={api} identity={IDENTITY} />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_tray_title", { title: "⚠ 1" }));
    tokenUsage = 10;
    window.dispatchEvent(new CustomEvent(MENU_TICK_EVENT));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_tray_title", { title: null }));
  });

  it("stops polling and clears the title on 401 until credentials change", async () => {
    const { api, usageCalls } = monitorApi((call) => call === 1
      ? jsonResponse({ group_by: "key", window_start: 1, usage: [usageRow(95)] })
      : jsonResponse({ error: { code: "UNAUTHORIZED", message: "bad token" } }, 401));
    render(<MenuBarMonitor api={api} identity={IDENTITY} />);

    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_tray_title", { title: "⚠ 1" }));
    window.dispatchEvent(new CustomEvent(MENU_TICK_EVENT));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_tray_title", { title: null }));
    expect(usageCalls()).toBe(2);
    expect(titleCalls()).toHaveLength(2);

    // 401 之后不再轮询（新的 tick 也不再发请求）。
    window.dispatchEvent(new CustomEvent(MENU_TICK_EVENT));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(usageCalls()).toBe(2);
  });

  it("clears the title when the gateway connection disappears", async () => {
    const { api } = monitorApi(() => jsonResponse({ group_by: "key", window_start: 1, usage: [usageRow(95)] }));
    const view = render(<MenuBarMonitor api={api} identity={IDENTITY} />);
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_tray_title", { title: "⚠ 1" }));
    view.rerender(<MenuBarMonitor api={null} identity={null} />);
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_tray_title", { title: null }));
  });

  it("keeps the last title on network failures, keeps retrying, then self-heals", async () => {
    const { api, usageCalls } = monitorApi((call) => {
      if (call === 1) return jsonResponse({ group_by: "key", window_start: 1, usage: [usageRow(95)] });
      if (call <= 3) return jsonResponse({ error: { code: "INTERNAL", message: "offline" } }, 502);
      return jsonResponse({ group_by: "key", window_start: 1, usage: [usageRow(10)] });
    });
    render(<MenuBarMonitor api={api} identity={IDENTITY} />);

    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_tray_title", { title: "⚠ 1" }));
    window.dispatchEvent(new CustomEvent(MENU_TICK_EVENT));
    await waitFor(() => expect(usageCalls()).toBe(2));
    // 网络失败不清标题；下一次 tick 仍会重试。
    expect(titleCalls()).toHaveLength(1);
    window.dispatchEvent(new CustomEvent(MENU_TICK_EVENT));
    await waitFor(() => expect(usageCalls()).toBe(3));
    // 恢复后按新数据重算（无告警 → 清空）。
    window.dispatchEvent(new CustomEvent(MENU_TICK_EVENT));
    await waitFor(() => expect(usageCalls()).toBe(4));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_tray_title", { title: null }));
  });

  it("counts alerts across the persisted global scope", async () => {
    window.localStorage.setItem("lutragate.menu-bar.scope", "global");
    const keys: AccessKeyRow[] = [
      { ...KEYS[0]!, id: "a1", user_id: "u1", name: "A" },
      { ...KEYS[0]!, id: "a2", user_id: "u2", name: "B" },
    ];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.includes("/admin/access-keys")) return jsonResponse(keys);
        if (url.includes("/admin/users")) return jsonResponse([
          { id: "u1", name: "alice", role: "user", enabled: true, created_at: 1, updated_at: 1, token_expires_at: 0, token_last_used_at: 0, token_hint: "" },
          { id: "u2", name: "bob", role: "user", enabled: true, created_at: 1, updated_at: 1, token_expires_at: 0, token_last_used_at: 0, token_hint: "" },
        ]);
        if (url.includes("/admin/usage")) {
          return jsonResponse({ group_by: "key", window_start: 1, usage: [
            { ...usageRow(95), access_key_id: "a1" },
            { ...usageRow(91), access_key_id: "a2" },
          ] });
        }
        return jsonResponse({});
      },
    });
    render(<MenuBarMonitor api={api} identity={IDENTITY} />);
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("set_tray_title", { title: "⚠ 2" }));
  });

  it("does not run overlapping polls when ticks arrive together", async () => {
    let usageCalls = 0;
    let release!: (response: Response) => void;
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.includes("/admin/access-keys")) return jsonResponse(KEYS);
        if (url.includes("/admin/usage")) {
          usageCalls++;
          return new Promise<Response>((resolve) => { release = resolve; });
        }
        return jsonResponse({});
      },
    });
    render(<MenuBarMonitor api={api} identity={IDENTITY} />);
    await waitFor(() => expect(usageCalls).toBe(1));
    window.dispatchEvent(new CustomEvent(MENU_TICK_EVENT));
    window.dispatchEvent(new CustomEvent(MENU_TICK_EVENT));
    expect(usageCalls).toBe(1);
    release(jsonResponse({ group_by: "key", window_start: 1, usage: [usageRow(95)] }));
    await waitFor(() => expect(usageCalls).toBe(1)); // 第二次 tick 未并发发出
  });
});
