import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminApi, type LogRow, type ProviderRow } from "../lib/api";
import { LogDb } from "../lib/logdb";
import { DashboardPanel } from "./DashboardPanel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const provider: ProviderRow = {
  id: "p1", name: "openai", type: "custom", endpoints: { openai: "https://a.test" }, enabled: 1, weight: 1, cooldown_failure_threshold: 0, cooldown_ms: 0, created_at: 1, updated_at: 1,
};

function log(id: string, ts: number, overrides: Partial<LogRow> = {}): LogRow {
  return {
    id, request_id: "r", ts, client_model: "m1", upstream_model: null,
    provider_id: "p1", key_id: null, prompt_tokens: 10, completion_tokens: 5,
    latency_ms: 50, status: 200, error_type: null,
    user_id: null, access_key_id: null, ...overrides,
  };
}

const HOUR = 3_600_000;

describe("DashboardPanel", () => {
  it("syncs on mount, stores rows locally and renders aggregates", async () => {
    const now = Date.now();
    const rows: LogRow[] = [
      log("a", now - HOUR, {}),
      log("b", now - HOUR + 1000, { status: 502, latency_ms: 2000 }),
      log("c", now - 2 * HOUR, { client_model: "m2", prompt_tokens: 100 }),
    ];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.includes("/admin/logs")) {
          if (url.includes("cursor=")) return jsonResponse({ logs: [], next_cursor: null });
          return jsonResponse({ logs: rows, next_cursor: null });
        }
        return jsonResponse([provider]);
      },
    });
    const db = new LogDb(`dash-${Math.random().toString(36).slice(2)}`);
    await db.open();

    render(<DashboardPanel api={api} db={db} />);

    // 统计卡：3 条请求、2 成功 1 失败 → 66.7%
    expect(await screen.findByText("66.7%")).toBeTruthy();
    expect(screen.getByText("请求量").parentElement!.textContent).toContain("3");
    expect(screen.getByText("Prompt Tokens").parentElement!.textContent).toContain("120");
    expect(screen.getAllByText("openai").length).toBeGreaterThan(0); // 供应商表 + 筛选下拉
    expect(screen.getAllByText("m2").length).toBeGreaterThan(0); // 模型用量表

    // 本地镜像已写入（同步幂等由 sync.test 覆盖）
    expect(await db.logs.count()).toBe(3);
    await db.delete();
  });

  it("filters by model via the dropdown", async () => {
    const now = Date.now();
    const rows = [
      log("a", now - HOUR, { client_model: "m1" }),
      log("b", now - HOUR, { client_model: "m2" }),
    ];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) =>
        url.includes("/admin/logs")
          ? jsonResponse({ logs: rows, next_cursor: null })
          : jsonResponse([provider]),
    });
    const db = new LogDb(`dash-${Math.random().toString(36).slice(2)}`);
    await db.open();

    render(<DashboardPanel api={api} db={db} />);
    await screen.findByText("100.0%"); // 初始 2 条全部成功
    expect(screen.getAllByText("m2").length).toBeGreaterThan(0); // 两个模型都在用量表

    fireEvent.change(screen.getByDisplayValue("全部模型"), { target: { value: "m1" } });
    await waitFor(() => {
      expect(screen.queryByText("m2", { selector: "td" })).toBeNull(); // 筛选后用量表中 m2 消失
    });
    await db.delete();
  });

  it("breaks usage down by user and filters with the user dropdown (multi-user)", async () => {
    const now = Date.now();
    const users = [
      { id: "u1", name: "alice", role: "user" as const, enabled: 1, token_expires_at: 0, token_last_used_at: 0, created_at: 1, updated_at: 1 },
      { id: "u2", name: "bob", role: "user" as const, enabled: 1, token_expires_at: 0, token_last_used_at: 0, created_at: 1, updated_at: 1 },
    ];
    const rows: LogRow[] = [
      log("a", now - HOUR, { user_id: "u1", prompt_tokens: 100 }),
      log("b", now - HOUR, { user_id: "u1", prompt_tokens: 20, status: 502 }),
      log("c", now - HOUR, { user_id: "u2", prompt_tokens: 7 }),
      log("d", now - HOUR, { user_id: null }),
    ];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.includes("/admin/logs")) {
          if (url.includes("cursor=")) return jsonResponse({ logs: [], next_cursor: null });
          return jsonResponse({ logs: rows, next_cursor: null });
        }
        if (url.endsWith("/admin/users")) return jsonResponse(users);
        return jsonResponse([provider]);
      },
    });
    const db = new LogDb(`dash-${Math.random().toString(36).slice(2)}`);
    await db.open();

    render(<DashboardPanel api={api} db={db} />);

    // 用户用量表：按请求量降序，用户名联表，无归属行有占位标签。
    await screen.findByText("alice"); // 用户下拉先渲染；等同步完成聚合出现
    await waitFor(() => {
      const userChart = screen.getByText("用户用量").closest(".chart")!;
      expect(userChart.textContent).toContain("alice");
    });
    const userChart = screen.getByText("用户用量").closest(".chart")!;
    expect(userChart.textContent).toContain("bob");
    expect(userChart.textContent).toContain("（无归属）");

    // 用户筛选：只看 bob 时统计卡降到 1 条请求。
    fireEvent.change(screen.getByLabelText("用户"), { target: { value: "u2" } });
    await waitFor(() => {
      expect(screen.getByText("请求量").parentElement!.textContent).toMatch(/\b1\b/);
    });
    await db.delete();
  });

  it("shows sync errors with a retry button", async () => {
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async () => jsonResponse({ error: { code: "UNAUTHORIZED", message: "missing or invalid admin token" } }, 401),
    });
    const db = new LogDb(`dash-${Math.random().toString(36).slice(2)}`);
    await db.open();

    render(<DashboardPanel api={api} db={db} />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("missing or invalid admin token");
    });
    expect(screen.getByRole("button", { name: "立即同步" })).toBeTruthy();
    await db.delete();
  });

  // ---- 仪表盘增强（desktop 04）---------------------------------------------------

  const DAY = 86_400_000;
  const localDay = (t: number): string => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  it("applies a custom from/to window (desktop 04)", async () => {
    const now = Date.now();
    const rows = [
      log("old", now - 3 * DAY, {}),
      log("recent", now - HOUR, {}),
    ];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) =>
        url.includes("/admin/logs")
          ? jsonResponse({ logs: rows, next_cursor: null })
          : jsonResponse([provider]),
    });
    const db = new LogDb(`dash-${Math.random().toString(36).slice(2)}`);
    await db.open();

    render(<DashboardPanel api={api} db={db} />);
    // 默认 7d 档：两条都在窗口内。
    await waitFor(() => {
      expect(screen.getByText("请求量").parentElement!.textContent).toMatch(/\b2\b/);
    });

    // 自定义窗 = 3 天前 ～ 2 天前（本地日闭区间）→ 只剩 old 一条。
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: localDay(now - 3 * DAY) } });
    fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: localDay(now - 2 * DAY) } });
    await waitFor(() => {
      expect(screen.getByText("请求量").parentElement!.textContent).toMatch(/\b1\b/);
    });
    await db.delete();
  });

  it("exports the visible rows as CSV via a Blob download (desktop 04)", async () => {
    const now = Date.now();
    const rows = [log("a", now - HOUR, {})];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) =>
        url.includes("/admin/logs")
          ? jsonResponse({ logs: rows, next_cursor: null })
          : jsonResponse([provider]),
    });
    const db = new LogDb(`dash-${Math.random().toString(36).slice(2)}`);
    await db.open();

    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL }); // jsdom 无实现，补桩

    render(<DashboardPanel api={api} db={db} />);
    await waitFor(() => {
      expect(screen.getByText("请求量").parentElement!.textContent).toMatch(/\b1\b/);
    });
    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:test"); // 延迟一拍回收（Safari 兼容）
    });
    await db.delete();
  });

  it("renders provider health cards and the warning bar; clicking it opens the logs page (dash-status 03)", async () => {
    const now = Date.now();
    const rows: LogRow[] = [
      // p1 近 1h：6 次 3 失败（50% 达阈值）→ failure_rate 触发。
      ...[502, 502, 502, 200, 200, 200].map((status, i) =>
        log(`f${i}`, now - i * 60_000, { status }),
      ),
      // 无渠道行（provider_id 空）→ no_channel 触发。
      log("n", now - 30_000, { provider_id: null, error_type: "NO_CHANNEL:no_mapping" }),
    ];
    const coolingKey = {
      id: "k1", provider_id: "p1", key_hint: "aaaa", enabled: 1, cooldown_until: now + 600_000,
      failure_count: 3, daily_token_limit: 0, daily_request_limit: 0, created_at: 1, updated_at: 1,
    };
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.includes("/admin/logs")) return jsonResponse({ logs: rows, next_cursor: null });
        if (url.includes("/admin/keys")) return jsonResponse([coolingKey]);
        return jsonResponse([provider]);
      },
    });
    const db = new LogDb(`dash-${Math.random().toString(36).slice(2)}`);
    await db.open();

    const onViewLogs = vi.fn();
    render(<DashboardPanel api={api} db={db} onViewLogs={onViewLogs} />);

    // 警示条三触发器齐亮（冷却 + 失败率 + 无渠道）；镜像同步晚于 API 拉取，
    // 等 failure_rate 触发器就位再断言。
    await waitFor(() => {
      const alert = screen.getByRole("button", { name: /近 1 小时异常：/ });
      expect(alert.textContent).toContain("失败率高（3/6）");
    });
    const alert = screen.getByRole("button", { name: /近 1 小时异常：/ });
    expect(alert.textContent).toContain("冷却中");
    expect(alert.textContent).toContain("无渠道");
    fireEvent.click(alert);
    expect(onViewLogs).toHaveBeenCalledTimes(1);

    // 供应商健康卡：启停徽标 + 权重 + 近 1h 统计 + 冷却至。
    expect(screen.getByText("启用")).toBeTruthy();
    expect(screen.getByText(/近 1 小时 6 次 · 失败 3 次/)).toBeTruthy();
    expect(screen.getByText(/权重 1/).textContent).toContain("冷却至");
    await db.delete();
  });

  it("hides the warning bar and marks idle providers when nothing fires (dash-status 03)", async () => {
    const now = Date.now();
    const rows = [log("a", now - 60_000, {})]; // 单次成功 → 无触发
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) =>
        url.includes("/admin/logs")
          ? jsonResponse({ logs: rows, next_cursor: null })
          : url.includes("/admin/keys")
            ? jsonResponse([])
            : jsonResponse([provider]),
    });
    const db = new LogDb(`dash-${Math.random().toString(36).slice(2)}`);
    await db.open();

    render(<DashboardPanel api={api} db={db} />);
    await screen.findByText("100.0%");
    expect(screen.queryByText(/近 1 小时异常：/)).toBeNull();
    expect(screen.getByText(/近 1 小时 1 次 · 失败 0 次/)).toBeTruthy();
    await db.delete();
  });
});
