import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminApi, type AccessKeyRow, type GrantRow, type Identity, type UsageRow, type UserRow } from "../lib/api";
import { MENU_BAR_SCOPE_KEY, MENU_PANEL_SHOWN_EVENT } from "../lib/menu-bar";
import { MenuBarPanel } from "./MenuBarPanel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const IDENTITY: Identity = { id: "u1", name: "alice", role: "administrator" };

function accessKey(over: Partial<AccessKeyRow>): AccessKeyRow {
  return {
    id: "k1",
    user_id: "u1",
    name: "场景",
    key_hint: "ab01",
    enabled: true,
    daily_token_limit: 0,
    daily_request_limit: 0,
    max_concurrency: 0,
    expires_at: 0,
    ip_allowlist: [],
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

function usageRow(over: Partial<UsageRow>): UsageRow {
  return {
    access_key_id: "k1",
    requests: 0,
    errors: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    avg_latency_ms: 0,
    ...over,
  };
}

function panelApi(
  keys: AccessKeyRow[],
  usage: UsageRow[],
  onUsage?: () => void,
  users: UserRow[] = [],
  grants: GrantRow[] = [],
  keyUsage?: (id: string) => Response,
) {
  return new AdminApi({
    baseUrl: "http://gw.test",
    adminToken: "t",
    fetcher: async (url) => {
      if (url.endsWith("/admin/users")) return jsonResponse(users);
      if (url.endsWith("/admin/me/grants")) return jsonResponse({ user_id: "u1", grants, models: [] });
      const keyUsageMatch = /\/admin\/keys\/([^/?]+)\/usage/.exec(url);
      if (keyUsageMatch?.[1] !== undefined && keyUsage !== undefined) return keyUsage(keyUsageMatch[1]);
      if (url.includes("/admin/access-keys")) return jsonResponse(keys);
      if (url.includes("/admin/usage")) {
        onUsage?.();
        return jsonResponse({ group_by: "key", window_start: 1, usage });
      }
      return jsonResponse({});
    },
  });
}

function grant(over: Partial<GrantRow> = {}): GrantRow {
  return {
    id: "g1",
    provider_key_id: "pu1",
    provider_id: "prov1",
    provider_name: "智谱 Coding",
    provider_type: "zhipu-coding",
    key_hint: "abcd",
    daily_token_limit: 0,
    daily_request_limit: 0,
    created_at: 1,
    ...over,
  };
}

function userRow(over: Partial<UserRow> = {}): UserRow {
  return {
    id: "u1",
    name: "alice",
    role: "user",
    enabled: true,
    created_at: 1,
    updated_at: 1,
    token_expires_at: 0,
    token_last_used_at: 0,
    token_hint: "",
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function renderPanel(api: AdminApi | null, identity: Identity | null = IDENTITY, credentialInvalid = false) {
  return render(
    <MenuBarPanel api={api} identity={identity} envName="家里" credentialInvalid={credentialInvalid} />,
  );
}

describe("MenuBarPanel (menu-bar-usage 03/04/05, self + global + upstream)", () => {
  it("shows the env name and only limited keys with used/limit lines for configured limits", async () => {
    const keys = [
      accessKey({ id: "a", name: "场景A", daily_token_limit: 1_000, daily_request_limit: 20 }),
      accessKey({ id: "b", name: "场景B" }), // unlimited → hidden
      accessKey({ id: "c", name: "场景C", daily_request_limit: 10 }),
    ];
    const usage = [
      usageRow({ access_key_id: "a", requests: 5, prompt_tokens: 600 }),
      usageRow({ access_key_id: "c", requests: 3 }),
    ];
    renderPanel(panelApi(keys, usage));

    expect(await screen.findByLabelText("菜单栏用量")).toBeTruthy();
    expect(screen.getByText("家里")).toBeTruthy();
    expect(await screen.findByText("场景A")).toBeTruthy();
    expect(screen.getByText("场景C")).toBeTruthy();
    expect(screen.queryByText("场景B")).toBeNull();
    // Tokens: prompt+completion = 600 / 1,000；请求 5 / 20。
    expect(screen.getByText(/600 \/ 1,000/)).toBeTruthy();
    expect(screen.getByText(/5 \/ 20/)).toBeTruthy();
    // 只配置请求限额的 key 不渲染 Tokens 行。
    expect(screen.getByTestId("menu-bar-fill-c-requests")).toBeTruthy();
    expect(screen.queryByTestId("menu-bar-fill-c-tokens")).toBeNull();
  });

  it("colours fills at the exact 70/90 cutoffs and pins exceeded keys first", async () => {
    const keys = [
      accessKey({ id: "warn", name: "Warn", daily_token_limit: 100 }),
      accessKey({ id: "danger", name: "Danger", daily_token_limit: 100 }),
      accessKey({ id: "over", name: "Over", daily_token_limit: 100 }),
      accessKey({ id: "over2", name: "Over2", daily_token_limit: 100 }),
    ];
    const usage = [
      usageRow({ access_key_id: "warn", prompt_tokens: 70 }),
      usageRow({ access_key_id: "danger", prompt_tokens: 90 }),
      usageRow({ access_key_id: "over", prompt_tokens: 100 }),
      usageRow({ access_key_id: "over2", prompt_tokens: 120 }),
    ];
    const { container } = renderPanel(panelApi(keys, usage));

    await screen.findByText("Over2");
    const rows = Array.from(container.querySelectorAll(".menu-bar-row")).map((r) => r.textContent ?? "");
    // 两把超限按占用率降序；used === limit 即超限。
    expect(rows[0]).toContain("Over2");
    expect(rows[1]).toContain("Over");
    expect(rows[2]).toContain("Danger");
    expect(rows[3]).toContain("Warn");
    expect(screen.getByTestId("menu-bar-fill-warn-tokens").className).toContain("warn");
    expect(screen.getByTestId("menu-bar-fill-danger-tokens").className).toContain("danger");
    expect(screen.getByTestId("menu-bar-fill-over-tokens").className).toContain("danger");
    expect(screen.getByTestId("menu-bar-row-over").className).toContain("exceeded");
  });

  it("keeps the administrator's self view to their own keys", async () => {
    const keys = [
      accessKey({ id: "mine", user_id: "u1", name: "我的场景", daily_token_limit: 100 }),
      accessKey({ id: "other", user_id: "u2", name: "别人的场景", daily_token_limit: 100 }),
    ];
    renderPanel(panelApi(keys, [usageRow({ access_key_id: "mine", prompt_tokens: 10 })]), IDENTITY);

    expect(await screen.findByText("我的场景")).toBeTruthy();
    expect(screen.queryByText("别人的场景")).toBeNull();
  });

  it("refreshes when the shell dispatches the panel-shown event", async () => {
    let usageCalls = 0;
    const api = panelApi(
      [accessKey({ id: "a", daily_token_limit: 100 })],
      [usageRow({ access_key_id: "a", prompt_tokens: 10 })],
      () => { usageCalls++; },
    );
    renderPanel(api);
    expect(await screen.findByText("场景")).toBeTruthy();
    expect(usageCalls).toBe(1);
    window.dispatchEvent(new CustomEvent(MENU_PANEL_SHOWN_EVENT));
    await waitFor(() => expect(usageCalls).toBe(2));
  });

  it("lets an administrator switch to the grouped global view without losing self view", async () => {
    const keys = [
      accessKey({ id: "mine", user_id: "u1", name: "我的场景", daily_token_limit: 100 }),
      accessKey({ id: "other", user_id: "u2", name: "别人的场景", daily_token_limit: 100 }),
      accessKey({ id: "other2", user_id: "u2", name: "别人的场景2", daily_token_limit: 100 }),
    ];
    const usage = [
      usageRow({ access_key_id: "mine", prompt_tokens: 60 }),
      usageRow({ access_key_id: "other", prompt_tokens: 80 }),
      usageRow({ access_key_id: "other2", prompt_tokens: 40 }),
    ];
    const users = [userRow({ id: "u1", name: "alice" }), userRow({ id: "u2", name: "bob" })];
    renderPanel(panelApi(keys, usage, undefined, users));

    expect(await screen.findByText("我的场景")).toBeTruthy();
    expect(screen.queryByText("别人的场景")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "全局" }));
    expect(await screen.findByText("别人的场景")).toBeTruthy();
    expect(screen.getByText("bob · 2 把受限 key")).toBeTruthy();
    expect(screen.getByText("alice · 1 把受限 key")).toBeTruthy();
    // 全局按组内最高占用率降序：bob 80% > alice 60%。
    const groups = Array.from(document.querySelectorAll(".menu-bar-group h3")).map((h) => h.textContent ?? "");
    expect(groups[0]).toContain("bob");
  });

  it("persists the scope across a panel rebuild", async () => {
    const keys = [
      accessKey({ id: "mine", user_id: "u1", name: "我的场景", daily_token_limit: 100 }),
      accessKey({ id: "other", user_id: "u2", name: "别人的场景", daily_token_limit: 100 }),
    ];
    const usage = [usageRow({ access_key_id: "mine", prompt_tokens: 1 }), usageRow({ access_key_id: "other", prompt_tokens: 2 })];
    const users = [userRow({ id: "u1", name: "alice" }), userRow({ id: "u2", name: "bob" })];
    const view = renderPanel(panelApi(keys, usage, undefined, users));
    expect(await screen.findByText("我的场景")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "全局" }));
    expect(await screen.findByText("别人的场景")).toBeTruthy();
    expect(window.localStorage.getItem(MENU_BAR_SCOPE_KEY)).toBe("global");

    view.unmount();
    renderPanel(panelApi(keys, usage, undefined, users));
    expect(await screen.findByText("别人的场景")).toBeTruthy();
    expect(screen.getByRole("button", { name: "全局" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps ordinary users on the self view and never fetches the user list", async () => {
    const urls: string[] = [];
    const keys = [accessKey({ id: "mine", user_id: "u2", name: "我的场景", daily_token_limit: 100 })];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        urls.push(url);
        if (url.includes("/admin/access-keys")) return jsonResponse(keys);
        if (url.includes("/admin/usage")) {
          return jsonResponse({ group_by: "key", window_start: 1, usage: [usageRow({ access_key_id: "mine", prompt_tokens: 10 })] });
        }
        return jsonResponse([]);
      },
    });
    renderPanel(api, { id: "u2", name: "bob", role: "user" });
    expect(await screen.findByText("我的场景")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "全局" })).toBeNull();
    expect(screen.queryByRole("button", { name: "自己" })).toBeNull();
    expect(urls.some((u) => u.endsWith("/admin/users"))).toBe(false);
  });

  it("does not issue a self fetch when a virtual administrator arrives late", async () => {
    let usageCalls = 0;
    const api = panelApi(
      [accessKey({ id: "a", user_id: "u1", daily_token_limit: 100 })],
      [usageRow({ access_key_id: "a", prompt_tokens: 10 })],
      () => { usageCalls++; },
      [userRow({ id: "u1", name: "alice" })],
    );
    const view = render(<MenuBarPanel api={api} identity={null} envName="家里" />);
    view.rerender(<MenuBarPanel api={api} identity={{ id: null, name: null, role: "administrator" }} envName="家里" />);
    expect(await screen.findByText("alice · 1 把受限 key")).toBeTruthy();
    expect(usageCalls).toBe(1);
  });

  it("shows only the global view to a virtual administrator", async () => {
    const keys = [
      accessKey({ id: "a", user_id: "u1", name: "A", daily_token_limit: 100 }),
      accessKey({ id: "b", user_id: "u2", name: "B", daily_token_limit: 100 }),
    ];
    renderPanel(
      panelApi(keys, [usageRow({ access_key_id: "a", prompt_tokens: 10 })], undefined, [
        userRow({ id: "u1", name: "alice" }),
        userRow({ id: "u2", name: "bob" }),
      ]),
      { id: null, name: null, role: "administrator" },
    );
    expect(await screen.findByText("alice · 1 把受限 key")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "自己" })).toBeNull();
    expect(screen.queryByRole("button", { name: "全局" })).toBeNull();
  });

  it("shows my grants' plan windows and stays put across scope changes", async () => {
    const now = Date.now();
    const api = panelApi([], [], undefined, [], [grant({ provider_key_id: "pu-normal" })], () => jsonResponse({
      key_id: "pu-normal",
      provider_type: "zhipu-coding",
      plan: "pro",
      windows: [{ key: "five_hour", label: "5 小时", percentage: 42, reset_at: now + 2 * 3600_000 }],
      fetched_at: now,
    }));
    renderPanel(api);

    expect(await screen.findByText("上游依赖")).toBeTruthy();
    expect(await screen.findByText("智谱 Coding")).toBeTruthy();
    expect(await screen.findByText("pro")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText(/刚刚/)).toBeTruthy();
    expect(screen.getByText(/最早重置 .*小时后重置/)).toBeTruthy();

    // 与 04 视角切换无关：切到全局后同一段仍在。
    fireEvent.click(screen.getByRole("button", { name: "全局" }));
    expect(screen.getByText("上游依赖")).toBeTruthy();
    expect(screen.getByText("智谱 Coding")).toBeTruthy();
  });

  it("renders only grants whose provider type has a usage adapter", async () => {
    let customCalls = 0;
    const api = panelApi(
      [],
      [],
      undefined,
      [],
      [
        grant({ provider_key_id: "pu-supported", provider_name: "智谱 Coding" }),
        grant({ provider_key_id: "pu-custom", provider_name: "自定义上游", provider_type: "custom" }),
      ],
      (id) => {
        if (id === "pu-custom") customCalls++;
        return jsonResponse({
          key_id: id,
          provider_type: "zhipu-coding",
          plan: "pro",
          windows: [{ key: "five_hour", label: "5 小时", percentage: 10 }],
          fetched_at: Date.now(),
        });
      },
    );
    renderPanel(api);
    expect(await screen.findByText("智谱 Coding")).toBeTruthy();
    expect(screen.queryByText("自定义上游")).toBeNull();
    expect(customCalls).toBe(0);
  });

  it("guides missing management credentials and reports upstream failures in gray", async () => {
    const api = panelApi([], [], undefined, [], [grant({ provider_key_id: "pu-nocreds" })], () => jsonResponse(
      { error: { code: "USAGE_NO_CREDENTIALS", message: "no credentials" } },
      400,
    ));
    renderPanel(api);
    expect(await screen.findByText("填写 AK/SK 以启用用量查询")).toBeTruthy();
  });

  it("shows a gray unavailable hint without failing the panel", async () => {
    const api = panelApi([], [], undefined, [], [grant({ provider_key_id: "pu-fail" })], () => jsonResponse(
      { error: { code: "UPSTREAM_ERROR", message: "智谱返回 HTTP 401" } },
      502,
    ));
    renderPanel(api);
    expect(await screen.findByText(/用量不可用：智谱返回 HTTP 401/)).toBeTruthy();
    expect(screen.getByLabelText("菜单栏用量")).toBeTruthy();
  });

  it("manually refreshes a plan window with refresh=1 and never polls by itself", async () => {
    const urls: string[] = [];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        urls.push(url);
        if (url.endsWith("/admin/me/grants")) return jsonResponse({ user_id: "u1", grants: [grant({ provider_key_id: "pu-refresh" })], models: [] });
        if (url.includes("/admin/keys/pu-refresh/usage")) {
          return jsonResponse({
            key_id: "pu-refresh",
            provider_type: "zhipu-coding",
            plan: "pro",
            windows: [{ key: "five_hour", label: "5 小时", percentage: 20, reset_at: Date.now() + 3600_000 }],
            fetched_at: Date.now(),
          });
        }
        if (url.includes("/admin/access-keys")) return jsonResponse([]);
        if (url.includes("/admin/usage")) return jsonResponse({ group_by: "key", window_start: 1, usage: [] });
        return jsonResponse({});
      },
    });
    renderPanel(api);
    expect(await screen.findByText("20%")).toBeTruthy();
    const usageUrls = urls.filter((u) => u.includes("/admin/keys/pu-refresh/usage"));
    expect(usageUrls).toHaveLength(1);
    expect(usageUrls[0]).not.toContain("refresh=1");

    const upstreamSection = screen.getByLabelText("上游依赖");
    fireEvent.click(within(upstreamSection).getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(urls.some((u) => u.includes("/admin/keys/pu-refresh/usage?refresh=1"))).toBe(true));
    // 没有定时器自动轮询：静置一段时间后仍是「初始 + 手动」两次。
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(urls.filter((u) => u.includes("/admin/keys/pu-refresh/usage")).length).toBe(2);
  });

  it("reloads the grants list when the panel is shown again", async () => {
    const grantsUrls: string[] = [];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.endsWith("/admin/me/grants")) {
          grantsUrls.push(url);
          return jsonResponse({ user_id: "u1", grants: [], models: [] });
        }
        if (url.includes("/admin/access-keys")) return jsonResponse([]);
        if (url.includes("/admin/usage")) return jsonResponse({ group_by: "key", window_start: 1, usage: [] });
        return jsonResponse({});
      },
    });
    renderPanel(api);
    await waitFor(() => expect(grantsUrls).toHaveLength(1));
    window.dispatchEvent(new CustomEvent(MENU_PANEL_SHOWN_EVENT));
    await waitFor(() => expect(grantsUrls).toHaveLength(2));
  });

  it("hides the upstream section for a virtual administrator (grants unavailable)", async () => {
    let grantsCalled = false;
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.endsWith("/admin/me/grants")) {
          grantsCalled = true;
          return jsonResponse({ error: { code: "BAD_REQUEST", message: "virtual administrator has no user_id" } }, 400);
        }
        if (url.includes("/admin/access-keys")) return jsonResponse([]);
        if (url.includes("/admin/usage")) return jsonResponse({ group_by: "key", window_start: 1, usage: [] });
        return jsonResponse({});
      },
    });
    renderPanel(api, { id: null, name: null, role: "administrator" });
    await waitFor(() => expect(grantsCalled).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("上游依赖")).toBeNull();
  });

  it("shows a re-login hint instead of loading when credentials are invalid", async () => {
    renderPanel(panelApi([], []), null, true);
    expect(await screen.findByText("凭证失效：请打开主窗口重新登录")).toBeTruthy();
    expect(screen.queryByText("加载中…")).toBeNull();
  });

  it("detects a 401 by itself, stops polling and shows the re-login hint", async () => {
    let usageCalls = 0;
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.includes("/admin/access-keys")) return jsonResponse([]);
        if (url.includes("/admin/me/grants")) return jsonResponse({ user_id: "u1", grants: [], models: [] });
        if (url.includes("/admin/usage")) {
          usageCalls++;
          return jsonResponse({ error: { code: "UNAUTHORIZED", message: "expired" } }, 401);
        }
        return jsonResponse({});
      },
    });
    renderPanel(api);
    expect(await screen.findByText("凭证失效：请打开主窗口重新登录")).toBeTruthy();
    expect(usageCalls).toBe(1);
    window.dispatchEvent(new CustomEvent(MENU_PANEL_SHOWN_EVENT));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(usageCalls).toBe(1); // 401 后不再轮询
  });

  it("keeps the last successful data with a stale timestamp when a refresh fails", async () => {
    let usageCall = 0;
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url) => {
        if (url.includes("/admin/access-keys")) {
          return jsonResponse([accessKey({ id: "ak1", daily_token_limit: 100, name: "场景" })]);
        }
        if (url.includes("/admin/me/grants")) return jsonResponse({ user_id: "u1", grants: [], models: [] });
        if (url.includes("/admin/usage")) {
          usageCall++;
          if (usageCall === 1) {
            return jsonResponse({ group_by: "key", window_start: 1, usage: [usageRow({ access_key_id: "ak1", prompt_tokens: 10 })] });
          }
          return jsonResponse({ error: { code: "INTERNAL", message: "offline" } }, 502);
        }
        return jsonResponse({});
      },
    });
    renderPanel(api);
    expect(await screen.findByText("场景")).toBeTruthy();
    window.dispatchEvent(new CustomEvent(MENU_PANEL_SHOWN_EVENT));
    expect(await screen.findByText(/加载失败：/)).toBeTruthy();
    expect(screen.getByText("场景")).toBeTruthy(); // 旧数据仍在
    expect(screen.getByText(/上次更新 /)).toBeTruthy();
  });

  it("offers a main-window entry when no gateway is connected", async () => {
    const invoke = vi.fn(() => Promise.resolve());
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    renderPanel(null, null);
    expect(await screen.findByText("未连接网关")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开 LutraGate" }));
    expect(invoke).toHaveBeenCalledWith("show_main_window");
  });

  it("renders explicit empty and disconnected states", async () => {
    renderPanel(panelApi([accessKey({ id: "b" })], []));
    expect(await screen.findByText("没有受限的 Key")).toBeTruthy();

    renderPanel(null, null);
    expect(await screen.findByText("未连接网关")).toBeTruthy();
  });
});

/** 面板环境切换（issues/08 后续）：>1 环境时头部下拉可直接切换；单环境退化为纯文本。 */
describe("MenuBarPanel env switcher", () => {
  const ENVS = [
    { id: "env-a", name: "本地", gatewayUrl: "http://a.test" },
    { id: "env-b", name: "园区", gatewayUrl: "http://b.test" },
  ];

  it("renders a header env select with multiple environments and switches via onSwitchEnv", async () => {
    const onSwitchEnv = vi.fn();
    render(
      <MenuBarPanel
        api={panelApi([accessKey({ id: "a", user_id: "u1", name: "A", daily_token_limit: 100 })], [])}
        identity={IDENTITY}
        envName="本地"
        environments={ENVS}
        activeEnvId="env-a"
        onSwitchEnv={onSwitchEnv}
      />,
    );
    const select = screen.getByRole("combobox", { name: "切换环境" }) as HTMLSelectElement;
    expect(select.value).toBe("env-a");
    fireEvent.change(select, { target: { value: "env-b" } });
    expect(onSwitchEnv).toHaveBeenCalledWith("env-b");
  });

  it("keeps a plain env label for a single environment (nothing to switch)", () => {
    render(
      <MenuBarPanel
        api={panelApi([], [])}
        identity={IDENTITY}
        envName="本地"
        environments={[ENVS[0]!]}
        activeEnvId="env-a"
        onSwitchEnv={vi.fn()}
      />,
    );
    expect(screen.queryByRole("combobox", { name: "切换环境" })).toBeNull();
    expect(screen.getByText("本地")).toBeTruthy();
  });
});
