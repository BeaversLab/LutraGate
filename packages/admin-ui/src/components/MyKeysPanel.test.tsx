import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminApi, type AccessKeyRow } from "../lib/api";
import { expiryToDateInput } from "../lib/access-control";
import { MyKeysPanel } from "./MyKeysPanel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const myKeys: AccessKeyRow[] = [
  { id: "ak1", user_id: "u2", name: "场景1-客服机器人", key_hint: "ab01", enabled: true, daily_token_limit: 0, daily_request_limit: 0, max_concurrency: 0, expires_at: 0, ip_allowlist: [], created_at: 1, updated_at: 1 },
  { id: "ak2", user_id: "u2", name: "scene-2", key_hint: "cd02", enabled: false, daily_token_limit: 5_000, daily_request_limit: 10, max_concurrency: 4, expires_at: 0, ip_allowlist: [], created_at: 1, updated_at: 1 },
];

/** 当日按 key 聚合（次数列与余量的「已用」来源）。 */
const todayUsage = {
  group_by: "key" as const,
  usage: [
    // ak2：请求恰好用满限额（触发 429 后的形态）→ 余 0；token 软墙越限 → 余 0。
    { access_key_id: "ak2", requests: 10, errors: 0, prompt_tokens: 3_000, completion_tokens: 2_200, avg_latency_ms: 10 },
  ],
};

/** 列表 GET（keys + 今日 usage）；写操作交 write handler 断言。 */
function makeApi(write?: (url: string, init: RequestInit) => Response) {
  return new AdminApi({
    baseUrl: "http://gw.test",
    adminToken: "t",
    fetcher: async (url, init) => {
      if (init?.method && init.method !== "GET" && write) return write(url, init);
      if (url.endsWith("/admin/access-keys")) return jsonResponse(myKeys);
      if (url.includes("/admin/usage")) return jsonResponse(todayUsage);
      return jsonResponse({});
    },
  });
}

/** 打开一行编辑页（打磨轮整页化）：点行尾「编辑 ›」→ DetailPage（aria-label=key 名）。 */
async function openEdit(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`编辑 ${name}`) }));
  await screen.findByRole("region", { name });
}

describe("MyKeysPanel (multi-user 07; 打磨轮对齐 Key 管理)", () => {
  it("lists my named keys as wide rows: status badge, limits/expiry summary, today's quota", async () => {
    render(<MyKeysPanel api={makeApi()} />);
    expect(await screen.findByText("场景1-客服机器人")).toBeTruthy();
    expect(screen.getByText("scene-2")).toBeTruthy();
    // 行内限额摘要 + 过期（ak1 不限/永不过期）。
    expect(screen.getAllByText("日 Token 限额：不限").length).toBeGreaterThan(0);
    expect(screen.getByText("日 Token 限额：5,000")).toBeTruthy();
    expect(screen.getAllByText("过期：永不过期").length).toBe(2);
    // 行内今日用量余量条：ak2 请求 10/10（余 0，触发 429 后的形态）；
    // token 5,200/5,000 软墙越限 → 余 0；并发上限展示。ak1 = 0 / 不限。
    expect(screen.getByText("请求 10 / 10（余 0）")).toBeTruthy();
    expect(screen.getByText("Tokens 5,200 / 5,000（余 0）")).toBeTruthy();
    expect(screen.getByText("并发 ≤ 4")).toBeTruthy();
    expect(screen.getByText("请求 0 / 不限")).toBeTruthy();
    expect(screen.getByText("Tokens 0 / 不限")).toBeTruthy();
    // 状态徽标：ak1 启用 / ak2 已停用。
    expect(screen.getByText("已停用")).toBeTruthy();
  });

  it("filters by name/hint search with two empty states", async () => {
    render(<MyKeysPanel api={makeApi()} />);
    expect(await screen.findByText("场景1-客服机器人")).toBeTruthy();
    // 命中名称。
    fireEvent.change(screen.getByLabelText("搜索 Key"), { target: { value: "客服" } });
    expect(screen.getByText("场景1-客服机器人")).toBeTruthy();
    expect(screen.queryByText("scene-2")).toBeNull();
    // 命中尾号。
    fireEvent.change(screen.getByLabelText("搜索 Key"), { target: { value: "cd02" } });
    expect(screen.getByText("scene-2")).toBeTruthy();
    expect(screen.queryByText("场景1-客服机器人")).toBeNull();
    // 无匹配 → 筛选态空态（区别于真没数据）。
    fireEvent.change(screen.getByLabelText("搜索 Key"), { target: { value: "zzz" } });
    expect(screen.getByText("没有匹配的 Key。")).toBeTruthy();
  });

  it("toggles a key inline from the row switch (no edit page needed)", async () => {
    const writes: Array<{ url: string; method: string; body?: unknown }> = [];
    render(
      <MyKeysPanel
        api={makeApi((url, init) => {
          writes.push({ url, method: init.method!, body: init.body ? JSON.parse(init.body as string) : undefined });
          return jsonResponse({});
        })}
      />,
    );
    // ak2 当前停用 → 滑块 aria-label「启用」。
    fireEvent.click(await screen.findByLabelText("启用"));
    await waitFor(() =>
      expect(writes).toContainEqual({ url: "http://gw.test/admin/access-keys/ak2", method: "PUT", body: { enabled: true } }),
    );
  });

  it("creates a key with optional limits and shows the lgk_ plaintext exactly once", async () => {
    render(
      <MyKeysPanel
        api={makeApi((url, init) => {
          expect([url, init.method]).toEqual(["http://gw.test/admin/access-keys", "POST"]);
          expect(JSON.parse(init.body as string)).toEqual({
            name: "新场景",
            daily_token_limit: 50_000,
            daily_request_limit: 100,
            max_concurrency: 0, // 留空 = 不限 → 0
          });
          return jsonResponse({ ...myKeys[0]!, id: "ak3", name: "新场景", access_key: "lgk_one-time-key" }, 201);
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "创建访问 Key" }));
    fireEvent.change(await screen.findByLabelText("名称"), { target: { value: "新场景" } });
    fireEvent.change(screen.getByLabelText("日 Token 限额"), { target: { value: "50000" } });
    fireEvent.change(screen.getByLabelText("日请求数限额"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(await screen.findByText("lgk_one-time-key")).toBeTruthy();
    expect(screen.getByText(/仅此一次展示/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /我已保存/ }));
    expect(screen.queryByText("lgk_one-time-key")).toBeNull();
  });

  it("scopes the administrator's self view to their own keys (quota ticket follow-up)", async () => {
    // 服务端对 admin 返回全部 key；面板按 identity.user_id 收窄为「自己的」，
    // 且当日用量查询带 user_id 过滤。
    const allKeys: AccessKeyRow[] = [
      { ...myKeys[0]!, user_id: "u1" }, // root 自己的
      { ...myKeys[1]!, user_id: "u9", name: "别人的场景" },
    ];
    const urls: string[] = [];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url, init) => {
        if (init?.method && init.method !== "GET") return jsonResponse({});
        urls.push(url);
        if (url.endsWith("/admin/access-keys")) return jsonResponse(allKeys);
        if (url.includes("/admin/usage")) {
          return jsonResponse({ group_by: "key", usage: [{ access_key_id: allKeys[0]!.id, requests: 1, errors: 0, prompt_tokens: 2, completion_tokens: 3, avg_latency_ms: 5 }] });
        }
        return jsonResponse({});
      },
    });
    render(<MyKeysPanel api={api} identity={{ id: "u1", name: "root", role: "administrator" }} />);

    expect(await screen.findByText("场景1-客服机器人")).toBeTruthy();
    expect(screen.queryByText("别人的场景")).toBeNull();
    expect(urls.some((u) => u.includes("user_id=u1"))).toBe(true);
  });

  it("renames, edits limits and deletes my own keys from the edit page", async () => {
    const writes: Array<{ url: string; method: string; body?: unknown }> = [];
    render(
      <MyKeysPanel
        api={makeApi((url, init) => {
          writes.push({ url, method: init.method!, body: init.body ? JSON.parse(init.body as string) : undefined });
          return jsonResponse({});
        })}
      />,
    );
    await openEdit("scene-2");

    // 编辑页：改名 + 三限额 + 过期/IP 白名单一并提交（留空 = 永不过期 / 不限）。
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "renamed" } });
    fireEvent.change(screen.getByLabelText("日 Token 限额"), { target: { value: "9999" } });
    fireEvent.change(screen.getByLabelText("日请求数限额"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(writes).toContainEqual({
        url: "http://gw.test/admin/access-keys/ak2",
        method: "PUT",
        body: { name: "renamed", daily_token_limit: 9_999, daily_request_limit: 42, max_concurrency: 4, expires_at: 0, ip_allowlist: [] },
      }),
    );

    // 删除（原「吊销」文案对齐管理侧）：useConfirm 二次确认（含尾号与 401 提示）后 DELETE。
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("****cd02");
    expect(dialog.textContent).toContain("401");
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() =>
      expect(writes).toContainEqual({ url: "http://gw.test/admin/access-keys/ak2", method: "DELETE" }),
    );
  });
});

// ---- 访问控制（access-control 03）---------------------------------------------

describe("MyKeysPanel access-control (03)", () => {
  const NOW = Date.now();
  const keysWithAccessControl: AccessKeyRow[] = [
    // 已过期（expires_at 在过去）→ 状态「已过期」+ 相对展示。
    { id: "akx", user_id: "u2", name: "expired-scene", key_hint: "ex99", enabled: true, daily_token_limit: 0, daily_request_limit: 0, max_concurrency: 0, expires_at: NOW - (2 * 86_400_000 - 3_600_000), ip_allowlist: ["10.0.0.0/8"], created_at: 1, updated_at: 1 },
    // 永不过期 + 白名单。
    { id: "aky", user_id: "u2", name: "windowed-scene", key_hint: "yk98", enabled: true, daily_token_limit: 0, daily_request_limit: 0, max_concurrency: 0, expires_at: NOW + (3 * 86_400_000 - 3_600_000), ip_allowlist: [], created_at: 1, updated_at: 1 },
  ];

  function makeApi(list: AccessKeyRow[], write?: (url: string, init: RequestInit) => Response) {
    return new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url, init) => {
        if (init?.method && init.method !== "GET" && write) return write(url, init);
        if (url.endsWith("/admin/access-keys")) return jsonResponse(list);
        if (url.includes("/admin/usage")) return jsonResponse({ group_by: "key", usage: [] });
        return jsonResponse({});
      },
    });
  }

  it("derives status (已过期) with the badge in the list and relative expiry in facts", async () => {
    render(<MyKeysPanel api={makeApi(keysWithAccessControl)} />);
    // 列表行内即见状态徽标（已过期，优先于启用）。
    expect(await screen.findByText("已过期")).toBeTruthy();
    await openEdit("expired-scene");
    expect(await screen.findByText("已过期 2 天")).toBeTruthy();

    // 另一行：3 天后过期（编辑页打开时列表已卸载——先「返回」回列表再切行）。
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    fireEvent.click(await screen.findByRole("button", { name: /编辑 windowed-scene/ }));
    expect(await screen.findByText("3 天后过期")).toBeTruthy();
  });

  it("edits expiry date and IP allowlist together (access-control)", async () => {
    const puts: unknown[] = [];
    render(
      <MyKeysPanel
        api={makeApi(keysWithAccessControl, (url, init) => {
          expect(url).toBe("http://gw.test/admin/access-keys/akx");
          puts.push(JSON.parse(init.body as string));
          return jsonResponse({});
        })}
      />,
    );
    await openEdit("expired-scene");
    // 回填：expired-scene 的日期与白名单。
    expect((screen.getByLabelText("过期时间") as HTMLInputElement).value).toBe(expiryToDateInput(NOW - (2 * 86_400_000 - 3_600_000)));
    expect((screen.getByLabelText("IP 白名单") as HTMLTextAreaElement).value).toBe("10.0.0.0/8");
    // 设未来日期 + 双栈列表 → 已过期 key 复活。
    fireEvent.change(screen.getByLabelText("过期时间"), { target: { value: "2026-12-01" } });
    fireEvent.change(screen.getByLabelText("IP 白名单"), { target: { value: "10.0.0.0/8\n2001:db8::/32" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(puts).toEqual([expect.objectContaining({
        expires_at: Date.parse("2026-12-01T23:59:59.999"),
        ip_allowlist: ["10.0.0.0/8", "2001:db8::/32"],
      })]),
    );
  });

  it("intercepts invalid CIDR lines before submitting and shows the error inline", async () => {
    const writes: unknown[] = [];
    render(
      <MyKeysPanel
        api={makeApi(keysWithAccessControl, (url, init) => {
          writes.push(init.method);
          return jsonResponse({});
        })}
      />,
    );
    await openEdit("expired-scene");
    fireEvent.change(screen.getByLabelText("IP 白名单"), { target: { value: "10.0.0.0/8\nnot-a-cidr" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    // 前端拦截：不发请求，aside 内联报错（含违规行）。
    expect((await screen.findByRole("alert")).textContent).toContain("not-a-cidr");
    expect(writes).toEqual([]);
  });
});
