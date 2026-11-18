import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AdminApi, type AccessKeyRow, type LogRow } from "../lib/api";
import { LogDb } from "../lib/logdb";
import { MyDashboardPanel } from "./MyDashboardPanel";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const myKeys: AccessKeyRow[] = [
  { id: "ak1", user_id: "u2", name: "场景1-客服机器人", key_hint: "ab01", enabled: true, daily_token_limit: 1_000, daily_request_limit: 20, max_concurrency: 0, expires_at: 0, ip_allowlist: [], created_at: 1, updated_at: 1 },
];

/** 每用例独立的本地镜像（desktop 04 起我的仪表盘也走 LogStore）。 */
function freshDb(): LogDb {
  return new LogDb(`my-dash-${Math.random().toString(36).slice(2)}`);
}

const DAY_MS = 86_400_000;

/**
 * 判别「当日余量」调用：聚合调用随时间窗（默认 7 天）也带 from，但余量调用
 * 的 from 恒为本地午夜（24h 内），7 天窗的 from 在 7 天前。
 */
function isDailyUsageUrl(url: string): boolean {
  const from = new URL(url).searchParams.get("from");
  return from !== null && Number(from) > Date.now() - DAY_MS;
}

describe("MyDashboardPanel (multi-user)", () => {
  it("renders personal stat cards plus per-key and per-model tables from /admin/usage", async () => {
    const urls: string[] = [];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        urls.push(url);
        if (url.includes("/admin/usage")) {
          if (url.includes("group_by=key")) {
            // 当日窗口（余量列）与按 key 聚合共用此分支，行集相同；
            // 余量列用当日数据：ak1 今日 5 请求 / 460 tokens。
            return jsonResponse({
              group_by: "key",
              usage: [
                { access_key_id: "ak1", requests: 12, errors: 2, prompt_tokens: 340, completion_tokens: 120, avg_latency_ms: 87 },
                { access_key_id: null, requests: 1, errors: 0, prompt_tokens: 5, completion_tokens: 5, avg_latency_ms: 9 },
                { access_key_id: "revoked-key-id-000000000", requests: 3, errors: 0, prompt_tokens: 0, completion_tokens: 0, avg_latency_ms: 0 },
              ],
            });
          }
          if (url.includes("group_by=model")) {
            return jsonResponse({
              group_by: "model",
              usage: [{ client_model: "gpt-4o", requests: 16, errors: 2, prompt_tokens: 345, completion_tokens: 125, avg_latency_ms: 80 }],
            });
          }
          return jsonResponse({
            group_by: null,
            usage: [{ requests: 16, errors: 2, prompt_tokens: 345, completion_tokens: 125, avg_latency_ms: 80 }],
          });
        }
        if (url.endsWith("/admin/access-keys")) return jsonResponse(myKeys);
        if (url.includes("/admin/logs")) return jsonResponse({ logs: [], next_cursor: null });
        return jsonResponse({});
      },
    });
    render(<MyDashboardPanel api={api} db={freshDb()} />);

    // 统计卡：总量与成功率（16 请求 2 错误 → 87.5%）。
    expect(await screen.findByText("87.5%")).toBeTruthy();
    expect(screen.getByText("请求量").parentElement!.textContent).toContain("16");
    expect(screen.getByText("Prompt Tokens").parentElement!.textContent).toContain("345");

    // 按 key 表：联表名称 + 数字与 /admin/usage 一致；可读回退两档。
    // （趋势图也展示 key 名，故用 findAll。）
    expect((await screen.findAllByText(/场景1-客服机器人/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ab01/).length).toBeGreaterThan(0);
    expect(screen.getByText("87")).toBeTruthy();
    expect(screen.getByText(/历史（无归属）/)).toBeTruthy();
    expect(screen.getByText(/已删除的 key/)).toBeTruthy();

    // 按模型表。
    expect(screen.getByText("gpt-4o")).toBeTruthy();

    // 口径回归（2026-11-16 评审）：聚合调用跟随时间窗（默认 7 天带 from）；
    // 非聚合（不分组）调用也不例外，余量调用才是当日窗口。
    const ungrouped = urls.filter((u) => u.includes("/admin/usage") && !u.includes("group_by"));
    expect(ungrouped.length).toBeGreaterThan(0);
    expect(ungrouped.every((u) => u.includes("from="))).toBe(true);
  });

  it("renders today's remainder column from daily usage vs key limits (quota)", async () => {
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.includes("/admin/usage")) {
          // 当日窗口（from=本地午夜）：ak1 今日 5 请求 / 460 tokens；其余维度给空集。
          if (isDailyUsageUrl(url)) {
            expect(url.includes("group_by=key")).toBe(true);
            return jsonResponse({
              group_by: "key",
              usage: [{ access_key_id: "ak1", requests: 5, errors: 0, prompt_tokens: 400, completion_tokens: 60, avg_latency_ms: 50 }],
            });
          }
          if (url.includes("group_by=key")) {
            return jsonResponse({ group_by: "key", usage: [{ access_key_id: "ak1", requests: 12, errors: 2, prompt_tokens: 340, completion_tokens: 120, avg_latency_ms: 87 }] });
          }
          if (url.includes("group_by=model")) {
            return jsonResponse({ group_by: "model", usage: [{ client_model: "gpt-4o", requests: 12, errors: 2, prompt_tokens: 340, completion_tokens: 120, avg_latency_ms: 80 }] });
          }
          return jsonResponse({ group_by: null, usage: [{ requests: 12, errors: 2, prompt_tokens: 340, completion_tokens: 120, avg_latency_ms: 80 }] });
        }
        if (url.endsWith("/admin/access-keys")) return jsonResponse(myKeys);
        if (url.includes("/admin/logs")) return jsonResponse({ logs: [], next_cursor: null });
        return jsonResponse({});
      },
    });
    render(<MyDashboardPanel api={api} db={freshDb()} />);

    // 限额 20 请求 / 1,000 tokens，今日已用 5 / 460 → 余 15 / 540。
    expect(await screen.findByText("请求 15 / Tokens 540")).toBeTruthy();
  });

  it("renders 不限 for keys without limits and unknown/legacy keys", async () => {
    const unlimited = [{ ...myKeys[0]!, daily_token_limit: 0, daily_request_limit: 0 }];
    const usage = (extra: Array<Record<string, unknown>>) => jsonResponse({ group_by: "key", usage: [
      { access_key_id: "ak1", requests: 9, errors: 0, prompt_tokens: 10, completion_tokens: 5, avg_latency_ms: 1 },
      ...extra,
    ] });
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.includes("/admin/usage")) {
          if (url.includes("group_by=model")) return jsonResponse({ group_by: "model", usage: [] });
          if (!url.includes("group_by=key")) return jsonResponse({ group_by: null, usage: [] });
          // 当日与全量同一形状；追加已删 key 与历史无归属行。
          return usage([
            { access_key_id: "revoked-key-id-000000000", requests: 1, errors: 0, prompt_tokens: 0, completion_tokens: 0, avg_latency_ms: 0 },
            { access_key_id: null, requests: 1, errors: 0, prompt_tokens: 0, completion_tokens: 0, avg_latency_ms: 0 },
          ]);
        }
        if (url.endsWith("/admin/access-keys")) return jsonResponse(unlimited);
        if (url.includes("/admin/logs")) return jsonResponse({ logs: [], next_cursor: null });
        return jsonResponse({});
      },
    });
    render(<MyDashboardPanel api={api} db={freshDb()} />);

    // 无限额 key、已删 key、历史无归属行 → 余量一律「不限」。
    const cells = await screen.findAllByText("不限");
    expect(cells.length).toBe(3);
  });

  it("scopes the administrator's self view with user_id and own keys only", async () => {
    const ownKey = { ...myKeys[0]!, user_id: "u1" };
    const othersKey = { ...myKeys[0]!, id: "ak9", user_id: "u9", name: "别人的场景" };
    const urls: string[] = [];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        urls.push(url);
        if (url.includes("/admin/usage")) {
          if (url.includes("group_by=key")) {
            return jsonResponse({ group_by: "key", usage: [{ access_key_id: "ak1", requests: 4, errors: 0, prompt_tokens: 10, completion_tokens: 6, avg_latency_ms: 1 }] });
          }
          if (url.includes("group_by=model")) {
            return jsonResponse({ group_by: "model", usage: [{ client_model: "m1", requests: 4, errors: 0, prompt_tokens: 10, completion_tokens: 6, avg_latency_ms: 1 }] });
          }
          return jsonResponse({ group_by: null, usage: [{ requests: 4, errors: 0, prompt_tokens: 10, completion_tokens: 6, avg_latency_ms: 1 }] });
        }
        if (url.endsWith("/admin/access-keys")) return jsonResponse([ownKey, othersKey]);
        if (url.includes("/admin/logs")) return jsonResponse({ logs: [], next_cursor: null });
        return jsonResponse({});
      },
    });
    render(<MyDashboardPanel api={api} db={freshDb()} identity={{ id: "u1", name: "root", role: "administrator" }} />);

    // 只联表出自己的 key；所有 usage 查询都带 user_id=u1。
    expect((await screen.findAllByText(/场景1-客服机器人/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/别人的场景/)).toBeNull();
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls.filter((u) => u.includes("/admin/usage"))) {
      expect(u).toContain("user_id=u1");
    }
  });

  it("drives the trend chart and CSV export from the local mirror with own rows only (desktop 04)", async () => {
    const HOUR = 3_600_000;
    const now = Date.now();
    const rows: LogRow[] = [
      { id: "r1", request_id: "q1", ts: now - HOUR, client_model: "m1", upstream_model: null, provider_id: "p1", key_id: null, prompt_tokens: 10, completion_tokens: 5, latency_ms: 10, status: 200, error_type: null, user_id: "u2", access_key_id: "ak1" },
      { id: "r2", request_id: "q2", ts: now - 2 * HOUR, client_model: "m1", upstream_model: null, provider_id: "p1", key_id: null, prompt_tokens: 1, completion_tokens: 1, latency_ms: 10, status: 200, error_type: null, user_id: "u2", access_key_id: "ak1" },
      // 他人/无归属行混入镜像时不得出现在「我的」趋势里。
      { id: "r3", request_id: "q3", ts: now - HOUR, client_model: "m1", upstream_model: null, provider_id: "p1", key_id: null, prompt_tokens: 99, completion_tokens: 99, latency_ms: 10, status: 200, error_type: null, user_id: "u9", access_key_id: "ak1" },
    ];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.includes("/admin/logs")) return jsonResponse({ logs: rows, next_cursor: null });
        if (url.includes("/admin/usage")) {
          if (url.includes("group_by=key") || url.includes("group_by=model")) {
            return jsonResponse({ group_by: url.includes("group_by=key") ? "key" : "model", usage: [] });
          }
          return jsonResponse({ group_by: null, usage: [] });
        }
        if (url.endsWith("/admin/access-keys")) return jsonResponse(myKeys);
        return jsonResponse({});
      },
    });
    render(<MyDashboardPanel api={api} db={freshDb()} identity={{ id: "u2", name: "家人", role: "user" }} />);

    // 趋势图：ak1 只计 r1/r2 两条（2 次）。
    const legend = (await screen.findByTestId("key-trend")).querySelector(".trend-legend")!;
    await waitFor(() => {
      expect([...legend.querySelectorAll(".legend-item")].some((n) => n.textContent!.includes("（****ab01）：2 次"))).toBe(true);
    });
    // 导出入口在。
    expect(screen.getByRole("button", { name: "导出 CSV" })).toBeTruthy();
  });

  it("renders the current-status section: key cards + upstream plan cards (dash-status 02)", async () => {
    const HOUR = 3_600_000;
    const now = Date.now();
    const row = (overrides: Partial<LogRow>): LogRow => ({
      id: "r", request_id: "q", ts: now, client_model: "m1", upstream_model: null, provider_id: "p1",
      key_id: null, prompt_tokens: 1, completion_tokens: 1, latency_ms: 10, status: 200, error_type: null,
      user_id: "u2", access_key_id: "ak1", ...overrides,
    });
    const rows: LogRow[] = [
      // ak1：最近的成功行（5 分钟前）+ 更早的失败行——状态卡取最近一条。
      row({ id: "r1", request_id: "q1", ts: now - 5 * 60_000 }),
      row({ id: "r2", request_id: "q2", ts: now - HOUR, status: 502, error_type: "BAD_GATEWAY" }),
      // ak2：唯一一条在 24h 窗外 → 灰态「今日无请求」。
      row({ id: "r3", request_id: "q3", ts: now - 30 * HOUR, access_key_id: "ak2" }),
    ];
    const keys = [
      ...myKeys,
      { ...myKeys[0]!, id: "ak2", name: "场景2-离线", key_hint: "cd02" },
    ];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.includes("/admin/logs")) return jsonResponse({ logs: rows, next_cursor: null });
        if (/\/admin\/keys\/.+\/usage/.test(url)) {
          return jsonResponse({
            key_id: "pk1", provider_type: "zhipu-coding", plan: "pro",
            windows: [{ key: "five_hour", label: "5 小时", percentage: 42, reset_at: now + HOUR }],
            fetched_at: now,
          });
        }
        if (url.includes("/admin/me/grants")) {
          return jsonResponse({
            user_id: "u2", models: [],
            grants: [{ id: "g1", provider_key_id: "pk1", provider_id: "p1", provider_name: "智谱 AI", provider_type: "zhipu-coding", key_hint: "k9z1", daily_token_limit: 0, daily_request_limit: 0, created_at: 1 }],
          });
        }
        if (url.includes("/admin/usage")) {
          if (url.includes("group_by=key")) return jsonResponse({ group_by: "key", usage: [] });
          if (url.includes("group_by=model")) return jsonResponse({ group_by: "model", usage: [] });
          return jsonResponse({ group_by: null, usage: [] });
        }
        if (url.endsWith("/admin/access-keys")) return jsonResponse(keys);
        return jsonResponse({});
      },
    });
    render(<MyDashboardPanel api={api} db={freshDb()} identity={{ id: "u2", name: "家人", role: "user" }} />);

    // 两段式小节标题。
    expect(screen.getByText("当前状态")).toBeTruthy();
    expect(screen.getByText("历史统计")).toBeTruthy();

    // 场景卡：ak1 状态徽标 + 最近请求（取 24h 窗内最近一条=成功）。
    expect((await screen.findAllByText("启用")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByText(/最近请求：.+ · 成功/)).toBeTruthy();
    });
    // ak2 唯一最近行超 24h 窗 → 灰态。
    expect(screen.getByText(/24 小时内无请求/)).toBeTruthy();

    // 上游套餐卡段：grant 视图 + KeyUsageCell 实际拉取渲染。
    expect(screen.getByText("上游套餐")).toBeTruthy();
    expect(screen.getByText(/智谱 AI（\*\*\*\*k9z1）/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("42%")).toBeTruthy();
    });
  });

  it("shows the no-keys empty state in the status section (dash-status 02)", async () => {
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.includes("/admin/me/grants")) return jsonResponse({ user_id: "u2", grants: [], models: [] });
        if (url.includes("/admin/usage")) return jsonResponse({ usage: [] });
        if (url.endsWith("/admin/access-keys")) return jsonResponse([]);
        if (url.includes("/admin/logs")) return jsonResponse({ logs: [], next_cursor: null });
        return jsonResponse({});
      },
    });
    render(<MyDashboardPanel api={api} db={freshDb()} identity={{ id: "u2", name: "家人", role: "user" }} />);

    expect(await screen.findByText("还没有访问 Key，去「我的 Key」创建。")).toBeTruthy();
    // 历史统计段仍在（grants 空 → 上游套餐段整段不渲染）。
    expect(screen.getByText("历史统计")).toBeTruthy();
    expect(screen.queryByText("上游套餐")).toBeNull();
  });
});
