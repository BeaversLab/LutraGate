import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminApi, type AccessKeyRow, type KeyRow, type ProviderRow, type UserRow } from "../lib/api";
import { UsersPanel } from "./UsersPanel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const users: UserRow[] = [
  { id: "u1", name: "root", role: "administrator", enabled: true, token_expires_at: 0, token_last_used_at: 0, token_hint: "gm01", created_at: 1, updated_at: 1 },
  { id: "u2", name: "alice", role: "user", enabled: true, token_expires_at: 0, token_last_used_at: 0, token_hint: "gm02", created_at: 1, updated_at: 1 },
];
const providers: ProviderRow[] = [
  { id: "p1", name: "deepseek", type: "deepseek", endpoints: { openai: "https://api.deepseek.com" }, enabled: 1, weight: 1, cooldown_failure_threshold: 0, cooldown_ms: 0, created_at: 1, updated_at: 1 },
  { id: "p2", name: "kimi", type: "kimi", endpoints: { openai: "https://x" }, enabled: 1, weight: 1, cooldown_failure_threshold: 0, cooldown_ms: 0, created_at: 1, updated_at: 1 },
];
const keys: KeyRow[] = [
  { id: "k1", provider_id: "p1", key_hint: "aa01", enabled: 1, cooldown_until: 0, failure_count: 0, daily_token_limit: 0, daily_request_limit: 0, created_at: 1, updated_at: 1 },
  { id: "k2", provider_id: "p1", key_hint: "bb02", enabled: 1, cooldown_until: 0, failure_count: 0, daily_token_limit: 0, daily_request_limit: 0, created_at: 1, updated_at: 1 },
  { id: "k3", provider_id: "p2", key_hint: "cc03", enabled: 1, cooldown_until: 0, failure_count: 0, daily_token_limit: 0, daily_request_limit: 0, created_at: 1, updated_at: 1 },
];
const accessKeys: AccessKeyRow[] = [
  { id: "a1", user_id: "u2", name: "日常编码", key_hint: "k9x1", enabled: true, daily_token_limit: 0, daily_request_limit: 0, max_concurrency: 0, expires_at: 0, ip_allowlist: [], created_at: 1, updated_at: 1 },
  { id: "a2", user_id: "u2", name: "办公室网关", key_hint: "ff02", enabled: true, daily_token_limit: 0, daily_request_limit: 0, max_concurrency: 0, expires_at: 0, ip_allowlist: ["192.168.10.0/24", "10.0.0.0/8", "fd00::/8"], created_at: 1, updated_at: 1 },
];

/** 列表 GET 命中（users/access-keys/keys/providers/grants）。 */
function getList(url: string): Response {
  if (url.endsWith("/admin/users")) return jsonResponse(users);
  if (url.endsWith("/admin/access-keys")) return jsonResponse(accessKeys);
  if (url.includes("/admin/keys")) return jsonResponse(keys);
  if (url.includes("/admin/providers")) return jsonResponse(providers);
  if (url.includes("/grants")) {
    return jsonResponse({
      user_id: "u2",
      grants: [{ id: "g1", provider_key_id: "k1", provider_id: "p1", provider_name: "deepseek", key_hint: "aa01", daily_token_limit: 300_000, daily_request_limit: 1_000, created_at: 1 }],
    });
  }
  return jsonResponse({});
}

/** 写请求（非 GET）交给 write handler，其余走列表 GET。 */
function makeApi(write?: (url: string, init: RequestInit) => Response) {
  return new AdminApi({
    baseUrl: "http://gw.test",
    adminToken: "t",
    fetcher: async (url, init) => {
      if (init?.method && init.method !== "GET" && write) return write(url, init);
      return getList(url);
    },
  });
}

/** 点击 alice 行打开编辑整页（默认落在「基本信息」页签）。 */
async function openUserPage(name = "alice") {
  const row = await screen.findByRole("row", { name: new RegExp(name) });
  fireEvent.click(row);
  return screen.findByRole("region");
}

describe("UsersPanel（表格列表 + 编辑整页，UI 2.0）", () => {
  it("lists users as table rows with role badge, token hint and inline switch", async () => {
    render(<UsersPanel api={makeApi()} />);
    const alice = await screen.findByRole("row", { name: /alice/ });
    expect(alice.textContent).toContain("user");
    expect(alice.textContent).toContain("lgm_****gm02");
    expect(alice.textContent).toContain("启用");
    expect(screen.getByRole("row", { name: /root/ }).textContent).toContain("administrator");
  });

  it("selecting a user opens the tabbed edit page; Escape closes it", async () => {
    render(<UsersPanel api={makeApi()} />);
    const row = await screen.findByRole("row", { name: /alice/ });
    fireEvent.click(row);
    const page = await screen.findByRole("region");
    expect(page.getAttribute("aria-label")).toBe("alice");
    // 三页签 + 默认基本信息（lgm_ 称管理凭证）。
    expect(screen.getByRole("tab", { name: "基本信息" }).getAttribute("aria-selected")).toBe("true");
    expect(page.textContent).toContain("管理凭证");
    // 入页焦点落在返回按钮（编辑态下列表已卸载，关页无从还原行焦点）。
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "返回" }));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
  });

  it("creates a user on the edit page and shows the lgm_ credential exactly once", async () => {
    const created = { ...users[1]!, id: "u3", name: "bob", management_token: "lgm_one-time-secret", token_hint: "cret" };
    render(
      <UsersPanel
        api={makeApi((url, init) => {
          expect([url, init.method]).toEqual(["http://gw.test/admin/users", "POST"]);
          expect(JSON.parse(init.body as string)).toEqual({ name: "bob", role: "user" });
          return jsonResponse(created, 201);
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "创建用户" }));
    const page = await screen.findByRole("region");
    expect(page.getAttribute("aria-label")).toBe("创建用户");
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    // 一次性展示：lgm_ 凭证可见；关闭后不可再见。
    expect(await screen.findByText("lgm_one-time-secret")).toBeTruthy();
    expect(screen.getByText(/仅此一次展示/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /我已保存/ }));
    expect(screen.queryByText("lgm_one-time-secret")).toBeNull();
  });

  it("resets the management credential on the edit page with the old-invalidated hint", async () => {
    render(
      <UsersPanel
        api={makeApi((url) => {
          expect(url).toBe("http://gw.test/admin/users/u2/token");
          return jsonResponse({ user_id: "u2", management_token: "lgm_rotated", token_hint: "ated" });
        })}
      />,
    );
    await openUserPage();
    fireEvent.click(screen.getByRole("button", { name: "重置管理凭证" }));
    expect(await screen.findByText("lgm_rotated")).toBeTruthy();
    expect(screen.getByText(/旧凭证已立即失效/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /我已保存/ }));
    expect(screen.queryByText("lgm_rotated")).toBeNull();
  });

  it("surfaces reset errors on the edit page without a dead placeholder dialog", async () => {
    render(
      <UsersPanel
        api={makeApi(() => jsonResponse({ error: { code: "INTERNAL", message: "boom" } }, 500))}
      />,
    );
    await openUserPage();
    fireEvent.click(screen.getByRole("button", { name: "重置管理凭证" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("boom");
    });
    expect(screen.queryByText(/正在重置/)).toBeNull();
    expect(screen.getByRole("region")).toBeTruthy(); // 编辑页不关
  });

  it("edits lgm_ expiry via PUT without rotating (access-control)", async () => {
    const puts: unknown[] = [];
    render(
      <UsersPanel
        api={makeApi((url, init) => {
          expect(url).toBe("http://gw.test/admin/users/u2/token");
          expect(init.method).toBe("PUT");
          puts.push(JSON.parse(init.body as string));
          return jsonResponse({ user_id: "u2", expires_at: 1, updated_at: 1 });
        })}
      />,
    );
    await openUserPage();
    fireEvent.change(screen.getByLabelText("过期时间"), { target: { value: "2026-12-01" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(puts).toEqual([{ expires_at: Date.parse("2026-12-01T23:59:59.999") }]),
    );
  });

  it("edits name and role in place via PUT (unchanged fields not sent)", async () => {
    const puts: unknown[] = [];
    render(
      <UsersPanel
        api={makeApi((url, init) => {
          expect(url).toBe("http://gw.test/admin/users/u2");
          puts.push(JSON.parse(init.body as string));
          return jsonResponse({ ...users[1]!, name: "alice2", role: "administrator" });
        })}
      />,
    );
    await openUserPage();
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "alice2" } });
    fireEvent.change(screen.getByLabelText("角色"), { target: { value: "administrator" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(puts).toEqual([{ name: "alice2", role: "administrator" }]));
  });

  it("locks the role select for the sole enabled administrator", async () => {
    render(<UsersPanel api={makeApi()} />);
    await openUserPage("root");
    // root 是唯一启用的 administrator：角色锁定 + 说明（server lastAdminGuard 兜底）。
    expect((screen.getByLabelText("角色") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("唯一启用的 administrator 不能降权。")).toBeTruthy();
    // 普通用户 alice 的角色可编辑。
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await openUserPage();
    expect((screen.getByLabelText("角色") as HTMLSelectElement).disabled).toBe(false);
  });

  it("toggles a user from the row switch and refreshes", async () => {
    let toggled = false;
    const api = new AdminApi({
      baseUrl: "http://gw.test", adminToken: "t",
      fetcher: async (url, init) => {
        if (init?.method === "PUT") { toggled = true; return jsonResponse({ ...users[1]!, enabled: false }); }
        if (url.endsWith("/admin/users")) return jsonResponse(toggled ? [users[0]!, { ...users[1]!, enabled: false }] : users);
        return getList(url);
      },
    });
    render(<UsersPanel api={api} />);
    const aliceRow = await screen.findByRole("row", { name: /alice/ });
    fireEvent.click(within(aliceRow).getByRole("checkbox", { name: "停用" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "启用" })).toBeTruthy());
    // 列表态常驻（行内滑块启停，不进编辑页）。
    expect(screen.getByRole("row", { name: /alice/ }).textContent).toContain("停用");
  });

  it("delete modal shows impact facts and warns only for the sole enabled administrator", async () => {
    const deletes: string[] = [];
    const usageCalls: string[] = [];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url, init) => {
        if (init?.method === "DELETE") {
          deletes.push(url);
          return jsonResponse({ deleted: true });
        }
        if (url.includes("/admin/usage")) {
          usageCalls.push(url);
          return jsonResponse({ group_by: null, usage: [{ requests: 7, errors: 0, prompt_tokens: 30, completion_tokens: 20, avg_latency_ms: 5 }] });
        }
        return getList(url);
      },
    });
    render(<UsersPanel api={api} />);
    await screen.findByRole("row", { name: /root/ });

    // alice（普通用户）：无唯一管理员警告；今日用量按 user_id 查一次。
    await openUserPage("alice");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    let dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("创建时间");
    expect(dialog.textContent).toContain("7 请求 / 50 tokens");
    expect(dialog.textContent).not.toContain("唯一启用");
    expect(usageCalls[0]).toContain("user_id=u2");
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(deletes).toEqual(["http://gw.test/admin/users/u2"]));
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull()); // 删除后回落列表态

    // root（唯一启用 administrator）：出现警告。
    await openUserPage("root");
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("唯一启用的 administrator");
  });

  it("surfaces last-administrator 409s readably for disable", async () => {
    const conflict = () =>
      jsonResponse({ error: { code: "CONFLICT", message: "cannot disable, demote or delete the last enabled administrator" } }, 409);
    render(<UsersPanel api={makeApi(conflict)} />);
    const rootRow = await screen.findByRole("row", { name: /root/ });
    fireEvent.click(within(rootRow).getByRole("checkbox", { name: "停用" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("last enabled administrator");
    });
  });
});

describe("UsersPanel grants tab (quota)", () => {
  it("edits grants with per-entry budgets and saves entry objects", async () => {
    const puts: unknown[] = [];
    render(
      <UsersPanel
        api={makeApi((url, init) => {
          expect(url).toBe("http://gw.test/admin/users/u2/grants");
          puts.push(JSON.parse(init.body as string));
          return jsonResponse({ user_id: "u2", grants: [] });
        })}
      />,
    );
    await openUserPage();
    fireEvent.click(screen.getByRole("tab", { name: "上游 Key 授权" }));

    // 按 provider 分组（编辑器异步拉取 providers/keys/grants）；k1 初始勾选（预算回填），k2/k3 未勾选。
    const page = screen.getByRole("region");
    expect(await screen.findByText("deepseek")).toBeTruthy();
    expect(page.textContent).toContain("kimi");
    const k1 = screen.getByLabelText("****aa01") as HTMLInputElement;
    const k2 = screen.getByLabelText("****bb02") as HTMLInputElement;
    const k3 = screen.getByLabelText("****cc03") as HTMLInputElement;
    expect(k1.checked).toBe(true);
    expect(k2.checked).toBe(false);
    expect(k3.checked).toBe(false);

    // 勾选行展开两个预算输入；现有预算已回填。
    expect((screen.getByLabelText(/aa01 日 Token 预算/) as HTMLInputElement).value).toBe("300000");
    expect((screen.getByLabelText(/aa01 日请求数预算/) as HTMLInputElement).value).toBe("1000");

    // 改 k1 的 token 预算；勾上 k3（预算留空 = 不限）。
    fireEvent.change(screen.getByLabelText(/aa01 日 Token 预算/), { target: { value: "500000" } });
    fireEvent.click(k3);
    // 整组替换：保存条目对象（含预算数字，0 = 不限）。
    fireEvent.click(screen.getByRole("button", { name: "保存授权" }));
    await waitFor(() =>
      expect(puts).toEqual([{
        provider_key_ids: [
          { provider_key_id: "k1", daily_token_limit: 500_000, daily_request_limit: 1_000 },
          { provider_key_id: "k3", daily_token_limit: 0, daily_request_limit: 0 },
        ],
      }]),
    );
  });
});

describe("UsersPanel access keys tab（表格 + 模态框）", () => {
  /** 打开 alice 编辑页的「访问 Key」页签。 */
  async function openKeysTab() {
    await openUserPage();
    fireEvent.click(screen.getByRole("tab", { name: "访问 Key" }));
    await screen.findByRole("row", { name: /日常编码/ });
  }

  it("lists the user's lgk_ as table rows with IP first-entry + count", async () => {
    render(<UsersPanel api={makeApi()} />);
    await openKeysTab();
    const row = screen.getByRole("row", { name: /日常编码/ });
    expect(row.textContent).toContain("****k9x1");
    expect(row.textContent).toContain("启用");
    // 空白名单 = 不限；多条只示意首条 + 余数。
    expect(row.textContent).toContain("不限");
    const withIps = screen.getByRole("row", { name: /办公室网关/ });
    expect(withIps.textContent).toContain("192.168.10.0/24 +2");
  });

  it("creates an access key via the modal and shows lgk_ exactly once", async () => {
    const posts: unknown[] = [];
    render(
      <UsersPanel
        api={makeApi((url, init) => {
          expect(url).toBe("http://gw.test/admin/users/u2/access-keys");
          posts.push(JSON.parse(init.body as string));
          return jsonResponse({ ...accessKeys[0]!, id: "a2", name: "ops", key_hint: "new1", access_key: "lgk_fresh-secret" }, 201);
        })}
      />,
    );
    await openKeysTab();
    fireEvent.click(screen.getByRole("button", { name: "创建访问 Key" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "ops" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    // 创建成功：模态关闭，明文仅 OneTimeSecret 一次。
    expect(await screen.findByText("lgk_fresh-secret")).toBeTruthy();
    expect(posts).toEqual([{ name: "ops" }]);
    expect(screen.queryByRole("dialog", { name: "创建访问 Key" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /我已保存/ }));
    expect(screen.queryByText("lgk_fresh-secret")).toBeNull();
  });

  it("edits expiry and IP allowlist in the edit modal via PUT", async () => {
    const puts: unknown[] = [];
    render(
      <UsersPanel
        api={makeApi((url, init) => {
          expect(url).toBe("http://gw.test/admin/access-keys/a1");
          puts.push(JSON.parse(init.body as string));
          return jsonResponse(accessKeys[0]!);
        })}
      />,
    );
    await openKeysTab();
    fireEvent.click(screen.getByRole("row", { name: /日常编码/ }));
    const modal = await screen.findByRole("dialog", { name: /编辑访问 Key — 日常编码/ });
    fireEvent.change(within(modal).getByLabelText("过期时间"), { target: { value: "2026-12-01" } });
    fireEvent.change(within(modal).getByLabelText(/IP 白名单/), { target: { value: "10.0.0.0/8\n2001:db8::/32" } });
    fireEvent.click(within(modal).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(puts).toEqual([{ expires_at: Date.parse("2026-12-01T23:59:59.999"), ip_allowlist: ["10.0.0.0/8", "2001:db8::/32"] }]),
    );
    // 保存成功：模态关闭。
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /编辑访问 Key/ })).toBeNull());
  });

  it("blocks invalid CIDR lines client-side and never PUTs", async () => {
    const puts: unknown[] = [];
    render(
      <UsersPanel
        api={makeApi((url, init) => {
          puts.push(init.body);
          return jsonResponse(accessKeys[0]!);
        })}
      />,
    );
    await openKeysTab();
    fireEvent.click(screen.getByRole("row", { name: /日常编码/ }));
    const modal = await screen.findByRole("dialog", { name: /编辑访问 Key/ });
    fireEvent.change(within(modal).getByLabelText(/IP 白名单/), { target: { value: "10.0.0.0/33" } });
    fireEvent.click(within(modal).getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/不是合法的 CIDR/)).toBeTruthy();
    expect(puts).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: /编辑访问 Key/ })).toBeTruthy(); // 模态不关
  });

  it("prompts before discarding unsaved modal edits", async () => {
    render(<UsersPanel api={makeApi()} />);
    await openKeysTab();
    fireEvent.click(screen.getByRole("row", { name: /日常编码/ }));
    const modal = await screen.findByRole("dialog", { name: /编辑访问 Key/ });
    fireEvent.change(within(modal).getByLabelText(/IP 白名单/), { target: { value: "10.0.0.0/8" } });
    fireEvent.click(within(modal).getByRole("button", { name: "取消" }));
    // 脏守卫：出现未保存确认（ConfirmModal），确认后才关编辑模态。
    const confirmDialog = await screen.findByRole("dialog", { name: "确认操作" });
    expect(confirmDialog.textContent).toContain("未保存的更改");
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /编辑访问 Key/ })).toBeNull());
  });

  it("disables an access key via the inline table switch (immediate PUT, no modal)", async () => {
    const puts: unknown[] = [];
    render(
      <UsersPanel
        api={makeApi((url, init) => {
          expect(url).toBe("http://gw.test/admin/access-keys/a1");
          puts.push(JSON.parse(init.body as string));
          return jsonResponse({ ...accessKeys[0]!, enabled: false });
        })}
      />,
    );
    await openKeysTab();
    const row = screen.getByRole("row", { name: /日常编码/ });
    fireEvent.click(within(row).getByRole("checkbox", { name: "停用" }));
    await waitFor(() => expect(puts).toEqual([{ enabled: false }]));
    // 滑块点击不冒泡触发行编辑：无模态。
    expect(screen.queryByRole("dialog", { name: /编辑访问 Key/ })).toBeNull();
  });

  it("deletes a key via the edit modal with confirm dialog", async () => {
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    const deletes: string[] = [];
    let deleted = false;
    const api = new AdminApi({
      baseUrl: "http://gw.test", adminToken: "t",
      fetcher: async (url, init) => {
        if (init?.method === "DELETE") { deleted = true; deletes.push(url); return jsonResponse({ deleted: true }); }
        if (url.endsWith("/admin/access-keys")) return jsonResponse(deleted ? [] : accessKeys);
        return getList(url);
      },
    });
    render(<UsersPanel api={api} />);
    await openKeysTab();
    fireEvent.click(screen.getByRole("row", { name: /日常编码/ }));
    const modal = await screen.findByRole("dialog", { name: /编辑访问 Key/ });
    fireEvent.click(within(modal).getByRole("button", { name: "删除" }));
    const confirmDialog = await screen.findByRole("dialog", { name: "确认操作" });
    expect(confirmDialog.textContent).toContain("删除访问 Key「日常编码（****k9x1）」？");
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(deletes).toEqual(["http://gw.test/admin/access-keys/a1"]));
    // 删除后列表刷新为空态；window.confirm 未被触碰。
    await waitFor(() => expect(screen.getByRole("region").textContent).toContain("还没有访问 Key"));
    expect(confirm).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
