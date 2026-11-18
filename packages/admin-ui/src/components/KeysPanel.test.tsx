import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminApi, type KeyRow, type ProviderRow } from "../lib/api";
import { KeysPanel } from "./KeysPanel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const provider: ProviderRow = {
  id: "p1", name: "deepseek", type: "deepseek", endpoints: { openai: "https://api.deepseek.com" },
  enabled: 1, weight: 1, cooldown_failure_threshold: 0, cooldown_ms: 0, created_at: 1, updated_at: 1,
};
const key: KeyRow = {
  id: "k1", provider_id: "p1", key_hint: "9876", enabled: 1,
  cooldown_until: 0, failure_count: 2, daily_token_limit: 1_000_000, daily_request_limit: 0, created_at: 1, updated_at: 1,
};

function makeApi(write?: (url: string, init: RequestInit) => Response) {
  return new AdminApi({
    baseUrl: "http://gw.test",
    adminToken: "t",
    fetcher: async (url, init) => {
      if (init?.method && init.method !== "GET" && write) return write(url, init);
      return jsonResponse(url.includes("/admin/keys") ? [key] : [provider]);
    },
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 行尾「编辑 ›」打开编辑整页（reference：列表态↔编辑态切换）。 */
async function openKeyPage(hint = "9876", providerName = "deepseek") {
  fireEvent.click(
    await screen.findByRole("button", { name: new RegExp(`^编辑 ${escapeRegExp(providerName)} Key（尾号 ${hint}）$`) }),
  );
  return screen.findByRole("region", { name: new RegExp(`${escapeRegExp(providerName)} · 上游 Key`) });
}

describe("KeysPanel（列表态：卡片宽行，reference）", () => {
  it("lists keys with provider, hint, labeled limits and last-used; 无供应商时给引导", async () => {
    const { unmount } = render(
      <KeysPanel
        api={new AdminApi({
          baseUrl: "http://gw.test", adminToken: "t",
          fetcher: async (url) =>
            jsonResponse(
              url.includes("/admin/keys")
                ? [{ ...key, last_used_at: Date.now() - 5 * 60_000 }]
                : [provider],
            ),
        })}
      />,
    );
    const card = (await screen.findByText("****9876")).closest(".prov-item")!;
    expect(card.textContent).toContain("deepseek");
    // 限额逐字段标名（formatLimit：0 = 不限）。
    expect(card.textContent).toContain("日 Token 限额：1,000,000");
    expect(card.textContent).toContain("日请求数限额：不限");
    // 最后使用时间（相对文案，滑块左侧）。
    expect(card.textContent).toContain("最后使用 5 分钟前");
    // 启用状态 = 行内滑块 + 状态文字（勾选态）。
    expect((screen.getByRole("checkbox", { name: "停用" }) as HTMLInputElement).checked).toBe(true);
    expect(card.textContent).toContain("启用");
    // 健康度直排行内（failure_count 2）。
    expect(card.textContent).toContain("失败 2 次");

    const emptyApi = new AdminApi({
      baseUrl: "http://gw.test", adminToken: "t",
      fetcher: async (url) => jsonResponse(url.includes("/admin/keys") ? [] : []),
    });
    unmount();
    render(<KeysPanel api={emptyApi} />);
    expect(await screen.findByText(/先在「供应商」里添加至少一个供应商/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "新增 Key" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("filter and search narrow the list; 两种空态分开", async () => {
    const zhipu: ProviderRow = { ...provider, id: "p2", name: "zhipu" };
    const key2: KeyRow = { ...key, id: "k2", provider_id: "p2", key_hint: "abcd" };
    const api = new AdminApi({
      baseUrl: "http://gw.test", adminToken: "t",
      fetcher: async (url) => jsonResponse(url.includes("/admin/keys") ? [key, key2] : [provider, zhipu]),
    });
    render(<KeysPanel api={api} />);

    await screen.findByText("****9876");
    // 供应商筛选：选 zhipu → deepseek 行消失。
    fireEvent.change(screen.getByRole("combobox", { name: "按供应商筛选" }), { target: { value: "p2" } });
    expect(screen.queryByText("****9876")).toBeNull();
    expect(screen.getByText("****abcd")).toBeTruthy();
    // 搜索：无命中空态 vs 尾号命中。
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索" }), { target: { value: "zzz" } });
    expect(screen.getByText("没有匹配的 Key。")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索" }), { target: { value: "abcd" } });
    expect(screen.getByText("****abcd")).toBeTruthy();
  });

  it("toggles a key via the row switch without opening the edit page", async () => {
    let toggled = false;
    const api = new AdminApi({
      baseUrl: "http://gw.test", adminToken: "t",
      fetcher: async (url, init) => {
        if (init?.method === "PUT") { toggled = true; return jsonResponse({ ...key, enabled: 0 }); }
        return jsonResponse(url.includes("/admin/keys") ? (toggled ? [{ ...key, enabled: 0 }] : [key]) : [provider]);
      },
    });
    render(<KeysPanel api={api} />);

    const rowSwitch = await screen.findByRole("checkbox", { name: "停用" });
    fireEvent.click(rowSwitch);
    await waitFor(() => expect(toggled).toBe(true));
    // 刷新后滑块翻转、状态文字变「停用」。
    await waitFor(() => {
      const updated = screen.getByRole("checkbox", { name: "启用" }) as HTMLInputElement;
      expect(updated.checked).toBe(false);
    });
  });

  it("shows health anomalies on the card with a reset-cooldown button; the edit page stays clean", async () => {
    const now = Date.now();
    const cooling: KeyRow = { ...key, cooldown_until: now + 60_000, failure_count: 5 };
    let resetCalls = 0;
    const api = new AdminApi({
      baseUrl: "http://gw.test", adminToken: "t",
      fetcher: async (url, init) => {
        if (init?.method === "PUT" && url.endsWith("/admin/keys/k1") && JSON.parse(String(init.body)).reset_cooldown) {
          resetCalls += 1;
          return jsonResponse({ ...key }); // 恢复后冷却/失败清零
        }
        return jsonResponse(url.includes("/admin/keys") ? (resetCalls > 0 ? [key] : [cooling]) : [provider]);
      },
    });
    render(<KeysPanel api={api} />);

    // 异常态在列表卡片：「冷却中」徽标 + 失败计数 + 恢复按钮。
    const card = (await screen.findByText("****9876")).closest(".prov-item")!;
    expect(card.textContent).toContain("冷却中");
    expect(card.textContent).toContain("失败 5 次");
    fireEvent.click(screen.getByRole("button", { name: "恢复冷却" }));
    await waitFor(() => expect(resetCalls).toBe(1));
    // 恢复后徽标/失败计数/按钮全部消失。
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "恢复冷却" })).toBeNull();
    });
    expect(screen.queryByText("冷却中")).toBeNull();
    expect(screen.queryByText("失败 5 次")).toBeNull();

    // 编辑页不再显示健康度信息（异常态只在列表卡片）。
    const page = await openKeyPage();
    expect(page.textContent).not.toContain("冷却中");
    expect(page.textContent).not.toContain("失败");
  });
});

describe("KeysPanel（编辑整页，reference）", () => {
  it("opens the edit page via the row-end button; Escape closes and returns to the list", async () => {
    const { container } = render(<KeysPanel api={makeApi()} />);
    const page = await openKeyPage();
    expect(page.getAttribute("aria-label")).toBe("deepseek · 上游 Key");
    // 掩码语义：页面只有尾号提示 + 「无法再次查看」说明，无复制完整密钥的入口。
    expect(page.textContent).toContain("****9876");
    expect(page.textContent).toContain("无法再次查看");
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
    // 动作行：删除靠左，测试连接/取消/保存靠右。deepseek 无管控凭证 UI
    // （CREDENTIALS_UI 未收录 → 无入口）。
    const actions = container.querySelector(".form-actions")!;
    expect([...actions.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "删除", "连通性测试", "取消", "保存",
    ]);
    // 配额/用量不在编辑页（用量只在列表卡片）。
    expect(page.textContent).not.toContain("套餐用量");
    expect(page.textContent).not.toContain("AFP");
    // 打开即焦点入编辑页（返回按钮）；Escape 关闭 = 页面卸载、列表回归。
    expect(document.activeElement?.getAttribute("aria-label")).toBe("返回");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "deepseek · 上游 Key" })).toBeNull());
    expect(screen.getByRole("button", { name: "编辑 deepseek Key（尾号 9876）" })).toBeTruthy();
  });

  it("opens the create page and submits a new key with asset-level limits", async () => {
    render(
      <KeysPanel
        api={makeApi((url, init) => {
          expect([url, init.method]).toEqual(["http://gw.test/admin/keys", "POST"]);
          expect(JSON.parse(init.body as string)).toEqual({
            provider_id: "p1",
            api_key: "sk-new",
            daily_token_limit: 2_000_000,
            daily_request_limit: 500,
          });
          return jsonResponse(key, 201);
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "新增 Key" }));
    const page = await screen.findByRole("region", { name: "新增 Key" });
    expect(page.textContent).toContain("立即在服务端加密");
    // 新建页动作行只有 取消/创建（无删除/测试连接）。
    const actions = page.querySelector(".form-actions")!;
    expect([...actions.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["取消", "创建"]);

    fireEvent.change(screen.getByLabelText("供应商", { selector: "select" }), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-new" } });
    fireEvent.change(screen.getByLabelText("日 Token 限额"), { target: { value: "2000000" } });
    fireEvent.change(screen.getByLabelText("日请求数限额"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "新增 Key" })).toBeNull());
  });

  it("edits asset-level limits on the page (empty = 不限; page stays open)", async () => {
    render(
      <KeysPanel
        api={makeApi((url, init) => {
          expect([url, init.method]).toEqual(["http://gw.test/admin/keys/k1", "PUT"]);
          expect(JSON.parse(init.body as string)).toEqual({ daily_token_limit: 3_000_000, daily_request_limit: 0 });
          return jsonResponse(key);
        })}
      />,
    );
    await openKeyPage();

    // 现有限额回填（token 1,000,000；请求空）。
    expect((screen.getByLabelText("日 Token 限额") as HTMLInputElement).value).toBe("1000000");
    fireEvent.change(screen.getByLabelText("日 Token 限额"), { target: { value: "3000000" } });
    fireEvent.change(screen.getByLabelText("日请求数限额"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    // 保存后保持编辑页（选中即编辑），不弹任何 dialog。
    await waitFor(() => expect(screen.getByRole("region", { name: "deepseek · 上游 Key" })).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("deletes via the in-page confirm dialog (window.confirm stays untouched)", async () => {
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    let deleted = false;
    const api = new AdminApi({
      baseUrl: "http://gw.test", adminToken: "t",
      fetcher: async (url, init) => {
        if (init?.method === "DELETE") { deleted = true; return jsonResponse({ deleted: true }); }
        return jsonResponse(url.includes("/admin/keys") ? (deleted ? [] : [key]) : [provider]);
      },
    });
    render(<KeysPanel api={api} />);

    await openKeyPage();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("删除 deepseek 的 Key（尾号 9876）？");
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(deleted).toBe(true));
    // 删除后列表清空、编辑页收起；桌面 WKWebView 语义：从未触碰 window.confirm。
    await waitFor(() => expect(screen.getByText(/还没有 Key/)).toBeTruthy());
    expect(screen.queryByRole("region", { name: "deepseek · 上游 Key" })).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("opens the connectivity test in a modal; Escape closes the modal and keeps the edit page", async () => {
    const api = new AdminApi({
      baseUrl: "http://gw.test", adminToken: "t",
      fetcher: async (url) => jsonResponse(url.includes("/admin/keys") ? [key] : [provider]),
    });
    render(<KeysPanel api={api} />);
    const page = await openKeyPage();

    // 编辑页本体没有测试内容（在模态框里）；Escape 只关模态。
    expect(screen.queryByRole("button", { name: "开始测试" })).toBeNull();
    fireEvent.click(within(page).getByRole("button", { name: "连通性测试" }));
    const dialog = await screen.findByRole("dialog", { name: "连通性测试" });
    expect(dialog.textContent).toContain("明文 Key 不会离开服务端");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("region", { name: "deepseek · 上游 Key" })).toBeTruthy();
  });

  it("runs a server-side key test in the modal and shows the outcome", async () => {
    const calls: string[] = [];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url, init) => {
        if (init?.method === "POST" && url.endsWith("/admin/keys/k1/test")) {
          calls.push(url);
          return jsonResponse({ key_id: "k1", model: "deepseek-chat", protocol: "openai", ok: false, latencyMs: 850, error: "HTTP 401：Incorrect API key" });
        }
        return jsonResponse(url.includes("/admin/keys") ? [key] : [provider]);
      },
    });

    render(<KeysPanel api={api} />);
    await openKeyPage();
    fireEvent.click(screen.getByRole("button", { name: "连通性测试" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始测试" }));

    await waitFor(() => {
      const row = screen.getByText("OpenAI", { selector: ".badge" }).closest(".endpoint-test-row")!;
      expect(row.textContent).toContain("连通失败");
      expect(row.textContent).toContain("Incorrect API key");
      expect(row.textContent).toContain("850 ms");
    });
    expect(calls).toEqual(["http://gw.test/admin/keys/k1/test"]);
  });
});

describe("KeysPanel usage + management credentials (provider-usage 04)", () => {
  const volcProvider: ProviderRow = { ...provider, id: "p1", name: "火山Agent Plan", type: "volcengine" };

  /** KeyUsageCell 有模块级缓存 → 每测独立 key id 防串。 */
  function usageApi(keyId: string, overrides?: {
    onUsage?: () => Response;
    onPut?: (body: unknown) => Response;
  }) {
    const keyRow = { ...key, id: keyId };
    return new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url, init) => {
        if (url.includes(`/admin/keys/${keyId}/usage`)) {
          return overrides?.onUsage
            ? overrides.onUsage()
            : jsonResponse({
                key_id: keyId, provider_type: "volcengine", plan: "Large",
                windows: [
                  { key: "five_hour", label: "5 小时", percentage: 25, absolute: "12.5 / 50 AFP", reset_at: 1 },
                  { key: "daily", label: "近 1 天", percentage: 10, absolute: "8 / 80 AFP" },
                  { key: "weekly", label: "本周", percentage: 20, absolute: "70 / 350 AFP" },
                  { key: "monthly", label: "本月", percentage: 43, absolute: "850.5 / 2000 AFP" },
                ],
                fetched_at: Date.now(),
              });
        }
        if (init?.method === "PUT" && url.endsWith(`/admin/keys/${keyId}`)) {
          return overrides?.onPut
            ? overrides.onPut(JSON.parse(String(init.body)))
            : jsonResponse({ ...keyRow });
        }
        return jsonResponse(url.includes("/admin/keys") ? [keyRow] : [volcProvider]);
      },
    });
  }

  it("shows usage bars on the list card; the edit page carries no usage section", async () => {
    render(<KeysPanel api={usageApi("k-u1")} />);
    // 列表卡片带用量条（provider-usage 04）。
    expect(await screen.findByText("12.5 / 50 AFP")).toBeTruthy();
    expect(screen.getByText("850.5 / 2000 AFP")).toBeTruthy();
    expect(screen.getByText("Large")).toBeTruthy();

    // 编辑页不再重复展示用量（用量只在列表）。
    const page = await openKeyPage("9876", "火山Agent Plan");
    expect(page.textContent).not.toContain("AFP");
    expect(page.textContent).not.toContain("套餐用量");
  });

  it("guides to the credentials modal when usage needs AK/SK (去填写聚焦 AK)", async () => {
    render(<KeysPanel api={usageApi("k-u2", { onUsage: () => jsonResponse({ error: { code: "USAGE_NO_CREDENTIALS", message: "no creds" } }, 400) })} />);
    // 列表卡片上的「去填写」：进编辑页并直接打开凭证模态框。
    fireEvent.click(await screen.findByRole("button", { name: "去填写" }));
    await screen.findByRole("region", { name: "火山Agent Plan · 上游 Key" });
    const dialog = await screen.findByRole("dialog", { name: "管控面凭证（AK/SK）" });
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Access Key ID"));
    // Escape 只关模态，编辑页保持。
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("region", { name: "火山Agent Plan · 上游 Key" })).toBeTruthy();
  });

  it("saves AK/SK in the credentials modal (PUT body carries plaintext once)", async () => {
    const bodies: unknown[] = [];
    render(<KeysPanel api={usageApi("k-u3", { onPut: (body) => { bodies.push(body); return jsonResponse({ ...key }); } })} />);
    const page = await openKeyPage("9876", "火山Agent Plan");
    // 动作行「管控面凭证」按钮打开模态框。
    fireEvent.click(within(page).getByRole("button", { name: "管控面凭证" }));
    const dialog = await screen.findByRole("dialog", { name: "管控面凭证（AK/SK）" });
    expect(dialog.textContent).toContain("只读权限的子账号");
    fireEvent.change(within(dialog).getByLabelText("Access Key ID"), { target: { value: "AKLT-x" } });
    fireEvent.change(within(dialog).getByLabelText("Secret Access Key"), { target: { value: "sk-secret" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存凭证" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      management_credentials: { type: "volcengine_ak_sk", access_key_id: "AKLT-x", secret_access_key: "sk-secret" },
    });
  });

  it("keeps credentials unchanged when saved empty (留空 = 保持不变，无请求)", async () => {
    const bodies: unknown[] = [];
    render(<KeysPanel api={usageApi("k-u5", { onPut: (body) => { bodies.push(body); return jsonResponse({ ...key }); } })} />);
    const page = await openKeyPage("9876", "火山Agent Plan");
    fireEvent.click(within(page).getByRole("button", { name: "管控面凭证" }));
    fireEvent.click(await screen.findByRole("button", { name: "保存凭证" }));
    // 全空提交 = 保持不变：不发 PUT，模态保持打开。
    await waitFor(() => expect(screen.getByRole("dialog", { name: "管控面凭证（AK/SK）" })).toBeTruthy());
    expect(bodies).toHaveLength(0);
  });

  it("rejects half-filled AK/SK and clears credentials with an explicit null", async () => {
    const bodies: unknown[] = [];
    render(<KeysPanel api={usageApi("k-u4", { onPut: (body) => { bodies.push(body); return jsonResponse({ ...key }); } })} />);
    const page = await openKeyPage("9876", "火山Agent Plan");
    fireEvent.click(within(page).getByRole("button", { name: "管控面凭证" }));
    const dialog = await screen.findByRole("dialog", { name: "管控面凭证（AK/SK）" });
    // 半填 → 客户端拦截，不发请求。
    fireEvent.change(within(dialog).getByLabelText("Access Key ID"), { target: { value: "AKLT-only" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存凭证" }));
    expect(await screen.findByText(/AK 与 SK 需同时填写/)).toBeTruthy();
    expect(bodies).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "清除凭证" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ management_credentials: null });
  });
});
