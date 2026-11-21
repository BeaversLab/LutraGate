import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AdminApi, type KeyRow, type ProviderRow } from "../lib/api";
import { ProvidersPanel } from "./ProvidersPanel";

const provider: ProviderRow = {
  id: "p1",
  name: "openai",
  type: "custom",
  endpoints: { openai: "https://api.openai.com" },
  enabled: 1,
  weight: 2,
  cooldown_failure_threshold: 0,
  cooldown_ms: 0,
  created_at: 1,
  updated_at: 1,
};

function makeApi(
  responder: (url: string, init?: RequestInit) => Response,
  keys: KeyRow[] = [],
): AdminApi {
  return new AdminApi({
    baseUrl: "http://gw.test",
    adminToken: "t",
    fetcher: async (url, init) => {
      // 健康度徽标（#21）的 keys 来源；默认空集，需要时经 keys 参数注入。
      if (url.endsWith("/admin/keys")) return jsonResponse(keys);
      return responder(url, init);
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 行尾「编辑 ›」打开编辑整页（reference：列表态↔编辑态切换）。 */
async function openEditPage(name = "openai") {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^编辑 ${escapeRegExp(name)}$`) }));
  return screen.findByRole("region", { name });
}

describe("ProvidersPanel（列表态：分类标签 + 宽行，reference）", () => {
  it("lists providers with status and weight", async () => {
    const api = makeApi(() => jsonResponse([provider]));
    render(<ProvidersPanel api={api} />);
    const row = (await screen.findByText("openai")).closest(".prov-item")!;
    expect(row.textContent).toContain("openai");
    expect(screen.getByTitle("https://api.openai.com").textContent).toBe("OpenAI 格式"); // 端点徽标
    expect(row.textContent).toContain("权重 2");
    // 启用状态 = 行内滑块 + 状态文字（勾选态）。
    expect((screen.getByRole("checkbox", { name: "停用" }) as HTMLInputElement).checked).toBe(true);
    expect(row.textContent).toContain("启用");
  });

  it("lays type/protocols/weight into the wide row without endpoint URLs", async () => {
    const api = makeApi(() => jsonResponse([provider]));
    render(<ProvidersPanel api={api} />);

    const row = (await screen.findByText("openai")).closest(".prov-item")!;
    // 行内显示类型徽标（custom → 「自定义」）、格式徽标、权重；不显示端点 URL。
    expect(row.textContent).toContain("自定义");
    expect(row.textContent).toContain("OpenAI 格式");
    expect(row.textContent).toContain("权重 2");
    expect(row.textContent).not.toContain("https://api.openai.com");
    // 行内动作 = 启用滑块 + 行尾编辑按钮；测试连接只在编辑页（需手输 Key）。
    expect(screen.getByRole("checkbox", { name: "停用" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "测试连接" })).toBeNull();
    expect(screen.getByRole("button", { name: "编辑 openai" })).toBeTruthy();
  });

  it("shows category tabs from preset categories and filters the list", async () => {
    // 自定义链路同属文本大模型（不单设分类）→ 标签只有 全部/文本语言。
    const zhipu: ProviderRow = { ...provider, id: "p2", name: "智谱", type: "zhipu" };
    const api = makeApi(() => jsonResponse([provider, zhipu]));
    render(<ProvidersPanel api={api} />);

    const tabs = await screen.findByRole("tablist", { name: "供应商" });
    const labels = [...tabs.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["全部", "文本语言"]);

    // 文本语言标签下 custom 与 preset 供应商都在（custom 链路属文本类）。
    fireEvent.click(within(tabs).getByRole("button", { name: "文本语言" }));
    const rowlist = screen.getByText("openai").closest(".rowlist")!;
    expect(rowlist.textContent).toContain("openai");
    expect(rowlist.textContent).toContain("智谱");
  });

  it("always shows the category tab bar while the list is non-empty (single category = 全部 + 该分类)", async () => {
    const api = makeApi(() => jsonResponse([provider]));
    render(<ProvidersPanel api={api} />);
    const tabs = await screen.findByRole("tablist", { name: "供应商" });
    const labels = [...tabs.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["全部", "文本语言"]); // 仅 custom 一家 → 也归文本语言
  });
});

describe("ProvidersPanel（编辑整页，reference）", () => {
  it("opens the create page and submits a new provider", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = makeApi((url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/admin/providers") && init?.method === "POST") {
        return jsonResponse({ ...provider, id: "p2" }, 201);
      }
      return jsonResponse([provider]);
    });
    render(<ProvidersPanel api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "新增供应商" }));
    const page = await screen.findByRole("region", { name: "新增供应商" });
    expect(page.getAttribute("aria-label")).toBe("新增供应商");

    fireEvent.change(screen.getByLabelText(/名称/, { selector: "input" }), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText(/OpenAI 格式 端点地址/), {
      target: { value: "https://api.deepseek.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(post!.init!.body as string)).toEqual({
        name: "deepseek",
        type: "custom",
        endpoints: { openai: "https://api.deepseek.com" },
        weight: 1,
        cooldown_failure_threshold: 0, // 留空 = 全局默认
        cooldown_ms: 0,
      });
    });
  });

  it("opens the edit page via the row-end button; Escape closes and returns to the list", async () => {
    const api = makeApi(() => jsonResponse([provider]));
    render(<ProvidersPanel api={api} />);
    const page = await openEditPage();
    expect(page.getAttribute("aria-label")).toBe("openai");
    // 打开即焦点入编辑页（返回按钮）；Escape 关闭 = 页面卸载、列表回归。
    expect(document.activeElement?.getAttribute("aria-label")).toBe("返回");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "openai" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "编辑 openai" })).toBeTruthy();
  });

  it("keeps delete and connectivity test on the save/cancel action row (delete leads, left)", async () => {
    const api = makeApi(() => jsonResponse([provider]));
    render(<ProvidersPanel api={api} />);
    const page = await openEditPage();

    const actions = page.querySelector(".form-actions")!;
    const names = [...actions.querySelectorAll("button")].map((b) => b.textContent);
    expect(names).toEqual(["删除", "连通性测试", "取消", "保存"]);
    // 删除钉在最左（margin-right:auto），其余靠右。
    expect(actions.querySelector(".form-actions-lead")!.textContent).toBe("删除");
  });

  it("opens connectivity test in a modal; Escape closes the modal and keeps the edit page", async () => {
    const api = makeApi((url) => {
      if (url.endsWith("/admin/providers/p1/models")) {
        return jsonResponse({ provider_id: "p1", protocol: "openai", models: [] });
      }
      return jsonResponse([provider]);
    });
    render(<ProvidersPanel api={api} />);
    const page = await openEditPage();

    // 编辑页本体没有测试段内容（在模态框里）。
    expect(screen.queryByLabelText(/测试 Key/)).toBeNull();
    fireEvent.click(within(page).getByRole("button", { name: "连通性测试" }));
    const dialog = await screen.findByRole("dialog", { name: "连通性测试" });
    expect(within(dialog).getByLabelText(/测试 Key/)).toBeTruthy();

    // Escape 只关模态框，编辑页保持打开。
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("region", { name: "openai" })).toBeTruthy();
  });

  it("edits cooldown overrides and echoes 0 = 全局默认 placeholders (access-control)", async () => {
    const puts: unknown[] = [];
    const api = makeApi((url, init) => {
      if (init?.method === "PUT") puts.push(JSON.parse(init.body as string));
      return jsonResponse([provider]);
    });
    render(<ProvidersPanel api={api} />);

    await openEditPage();
    // 0 = 全局默认的占位提示在编辑页表单里。
    expect(screen.getByRole("region", { name: "openai" }).textContent).toContain("全局默认（连续 3 次失败 / 冷却 60 秒）");
    fireEvent.change(screen.getByLabelText(/冷却阈值/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/冷却时长/), { target: { value: "120000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(puts).toContainEqual(expect.objectContaining({ cooldown_failure_threshold: 5, cooldown_ms: 120_000 })),
    );
  });

  it("toggles a provider via the row switch without opening the edit page", async () => {
    const puts: string[] = [];
    let toggled = false;
    const api = makeApi((url, init) => {
      if (init?.method === "PUT") {
        puts.push(url);
        toggled = true;
      }
      return jsonResponse([toggled ? { ...provider, enabled: 0 } : provider]);
    });
    render(<ProvidersPanel api={api} />);

    // 行内滑块启停：aria-label 翻转（启用→停用动作语义）。
    const rowSwitch = await screen.findByRole("checkbox", { name: "停用" });
    fireEvent.click(rowSwitch);
    await waitFor(() => expect(puts).toContain("http://gw.test/admin/providers/p1"));
    // 刷新后滑块翻转为未勾选、aria-label 变「启用」。
    await waitFor(() => {
      const updated = screen.getByRole("checkbox", { name: "启用" }) as HTMLInputElement;
      expect(updated.checked).toBe(false);
    });
    // 编辑页不含启停控件（滑块只在列表行；顶栏状态徽标也已移除）。
    await openEditPage();
    expect(screen.queryByRole("checkbox", { name: "启用" })).toBeNull();
    expect(screen.getByRole("region", { name: "openai" }).textContent).not.toContain("停用");
  });

  it("aggregates key health (failures / cooling) into the row and edit page (#21)", async () => {
    const now = Date.now();
    const keys: KeyRow[] = [
      { id: "k1", provider_id: "p1", key_hint: "aa01", enabled: 1, cooldown_until: now + 60_000, failure_count: 3, daily_token_limit: 0, daily_request_limit: 0, created_at: 1, updated_at: 1 },
      { id: "k2", provider_id: "p1", key_hint: "bb02", enabled: 1, cooldown_until: 0, failure_count: 2, daily_token_limit: 0, daily_request_limit: 0, created_at: 1, updated_at: 1 },
    ];
    const api = makeApi(() => jsonResponse([provider]), keys);
    render(<ProvidersPanel api={api} />);

    // 行内：失败合计 5 次 + 冷却中徽标（口径 = KeyRow 聚合，同 Key 管理）。
    const row = (await screen.findByText("openai")).closest(".prov-item")!;
    expect(row.textContent).toContain("失败 5 次");
    expect(row.textContent).toContain("冷却中");

    // 编辑页顶部位：完整冷却时间。
    await openEditPage();
    const page = screen.getByRole("region", { name: "openai" });
    expect(page.textContent).toContain("冷却至");
    expect(page.textContent).toContain("失败 5 次");
  });

  it("deletes via the in-page confirm dialog (window.confirm stays untouched)", async () => {
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    const deletes: string[] = [];
    let deleted = false;
    const api = makeApi((url, init) => {
      if (init?.method === "DELETE") {
        deletes.push(url);
        deleted = true;
        return jsonResponse({ deleted: true });
      }
      return jsonResponse(deleted ? [] : [provider]);
    });
    render(<ProvidersPanel api={api} />);

    await openEditPage();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("删除供应商「openai」？");
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(deletes).toContain("http://gw.test/admin/providers/p1"));
    // 删除后列表清空、编辑页收起。
    await waitFor(() => expect(screen.getByText(/还没有供应商/)).toBeTruthy());
    expect(screen.queryByRole("region", { name: "openai" })).toBeNull();
    // 桌面 WKWebView 语义：从未触碰 window.confirm。
    expect(confirm).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("surfaces API errors with the unified message", async () => {
    const api = makeApi(() =>
      jsonResponse({ error: { code: "UNAUTHORIZED", message: "missing or invalid admin token" } }, 401),
    );
    render(<ProvidersPanel api={api} />);
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("missing or invalid admin token");
    });
  });

  it("runs a connectivity test through the server relay and shows latency and errors", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = makeApi((url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/admin/providers/p1/test")) {
        return jsonResponse({ provider_id: "p1", protocol: "openai", model: "gpt-4o", ok: false, latencyMs: 123, error: "HTTP 401：Incorrect API key" });
      }
      if (url.endsWith("/admin/providers/p1/models")) {
        return jsonResponse({ provider_id: "p1", protocol: "openai", models: ["gpt-4o"] });
      }
      return jsonResponse([provider]);
    });
    render(<ProvidersPanel api={api} />);

    await openEditPage();
    // 连通性测试在模态框：打开即拉上游模型候选（model-discovery 01）。
    fireEvent.click(screen.getByRole("button", { name: "连通性测试" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/admin/providers/p1/models"))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText(/来自上游模型列表/)).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/测试 Key/, { selector: "input" }), {
      target: { value: "sk-test" },
    });
    fireEvent.change(screen.getByLabelText(/测试模型/, { selector: "input" }), {
      target: { value: "gpt-4o" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始测试" }));

    await waitFor(() => {
      const row = screen.getAllByText("OpenAI", { selector: ".endpoint-test-row .badge" })[0]!.closest(".endpoint-test-row")!;
      expect(row.textContent).toContain("连通失败");
      expect(row.textContent).toContain("Incorrect API key");
    });
    // 转发请求体：手输 Key + 显式 protocol + model。
    const testCall = calls.find((c) => c.url.endsWith("/admin/providers/p1/test"));
    expect(JSON.parse(testCall!.init?.body as string)).toEqual({
      api_key: "sk-test",
      protocol: "openai",
      model: "gpt-4o",
    });
  });

  it("blocks the connectivity test when the key is under 4 chars and never calls the API", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = makeApi((url, init) => {
      calls.push({ url, init });
      return jsonResponse([provider]);
    });
    render(<ProvidersPanel api={api} />);

    await openEditPage();
    fireEvent.click(screen.getByRole("button", { name: "连通性测试" }));
    await waitFor(() => {
      expect(screen.getByText(/来自上游模型列表|来自预设清单|可手动输入模型名/)).toBeTruthy();
    });
    // 3 字符（服务端阈值 ≥4）：拦截在校验层，不发 /test 请求（自托管宿主卡死实录的触发条件）。
    fireEvent.change(screen.getByLabelText(/测试 Key/, { selector: "input" }), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始测试" }));

    await waitFor(() => {
      // #22 去重：校验错误只出现在端点结果行，不再叠加页面级 alert。
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(calls.some((c) => c.url.endsWith("/test"))).toBe(false);
    // 端点行落成失败而非「测试中…」挂死，按钮复位可再次点击。
    const row = screen.getAllByText("OpenAI", { selector: ".endpoint-test-row .badge" })[0]!.closest(".endpoint-test-row")!;
    expect(row.textContent).toContain("连通失败");
    expect(row.textContent).toContain("测试 Key 至少 4 个字符");
    expect(screen.getByRole("button", { name: "开始测试" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps the test key only for the current provider's edit page (#22)", async () => {
    const second: ProviderRow = { ...provider, id: "p2", name: "deepseek", endpoints: { openai: "https://api.deepseek.com" } };
    const apis: string[] = [];
    const api = makeApi((url) => {
      apis.push(url);
      if (url.endsWith("/admin/providers/p2/models")) {
        return jsonResponse({ provider_id: "p2", protocol: "openai", models: [] });
      }
      if (url.endsWith("/admin/providers/p1/models")) {
        return jsonResponse({ provider_id: "p1", protocol: "openai", models: [] });
      }
      return jsonResponse([provider, second]);
    });
    render(<ProvidersPanel api={api} />);

    // 供应商 A：打开测试模态框，输入测试 Key。
    await openEditPage("openai");
    fireEvent.click(screen.getByRole("button", { name: "连通性测试" }));
    fireEvent.change(await screen.findByLabelText(/测试 Key/, { selector: "input" }), { target: { value: "sk-provider-a" } });

    // Escape 关模态 → 返回列表 → 编辑供应商 B：重挂 → Key 不残留（数据层即清）。
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await screen.findByRole("button", { name: "编辑 deepseek" });
    fireEvent.click(screen.getByRole("button", { name: "编辑 deepseek" }));
    await screen.findByRole("region", { name: "deepseek" });
    fireEvent.click(screen.getByRole("button", { name: "连通性测试" }));
    expect((await screen.findByLabelText(/测试 Key/, { selector: "input" }) as HTMLInputElement).value).toBe("");
  });
});

describe("ProvidersPanel preset providers", () => {
  it("auto-fills base_url and name when a preset type is picked", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const api = makeApi((url, init) => {
      calls.push({ init });
      if (init?.method === "POST") return jsonResponse({ ...provider, id: "p2" }, 201);
      return jsonResponse([provider]); // GET 列表
    });
    render(<ProvidersPanel api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "新增供应商" }));
    // 选智谱（已验证 preset）：base_url 自动填默认地址
    fireEvent.change(screen.getByLabelText(/供应商类型/, { selector: "select" }), {
      target: { value: "zhipu" },
    });
    expect((screen.getByLabelText(/OpenAI 格式 端点地址/) as HTMLInputElement).value).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
    expect((screen.getByLabelText(/Anthropic 格式 端点地址/) as HTMLInputElement).value).toBe(
      "https://open.bigmodel.cn/api/anthropic", // 预置双端点自动填充
    );
    // 名称留空 → 自动取预置中文名
    expect((screen.getByLabelText(/名称/, { selector: "input" }) as HTMLInputElement).value).toBe(
      "智谱 GLM",
    );

    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === "POST");
      expect(JSON.parse(post!.init!.body as string)).toMatchObject({
        type: "zhipu",
        endpoints: { openai: "https://open.bigmodel.cn/api/paas/v4" },
      });
    });
  });

  it("groups same-vendor presets into optgroups in the type dropdown", async () => {
    const api = makeApi(() => jsonResponse([provider]));
    render(<ProvidersPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "新增供应商" }));
    const select = screen.getByLabelText(/供应商类型/, { selector: "select" }) as HTMLSelectElement;
    const groupsArr = Array.from(select.querySelectorAll("optgroup"));
    const labels = groupsArr.map((g) => g.getAttribute("label"));
    expect(labels).toContain("智谱");
    expect(labels).toContain("火山引擎");
    const zhipuGroup = groupsArr.find((g) => g.getAttribute("label") === "智谱")!;
    expect(zhipuGroup.querySelectorAll("option")).toHaveLength(3); // 国内普通 API、国内套餐、国际普通 API
    // 自定义选项在 optgroup 之外。
    const topLevelOptions = [...select.children].filter((c) => c.tagName === "OPTION");
    expect(topLevelOptions.some((o) => (o as HTMLOptionElement).value === "custom")).toBe(true);
    // 官方文档已核对的预设和已实测预设都可选择。
    const optionValues = [...select.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value);
    expect(optionValues).toEqual(expect.arrayContaining(["openai", "anthropic", "google", "groq", "openrouter", "xai", "mistral"]));
    expect(optionValues).not.toContain("deepseek");
    expect(optionValues).not.toContain("moonshot");
  });

  it("offers documented international presets as untested and fills their own endpoints", async () => {
    const api = makeApi(() => jsonResponse([provider]));
    render(<ProvidersPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "新增供应商" }));
    const select = screen.getByLabelText(/供应商类型/, { selector: "select" });
    const option = screen.getByRole("option", { name: /Z\.ai/ }) as HTMLOptionElement;
    expect(option.textContent).not.toContain("待实测");
    fireEvent.change(select, { target: { value: option.value } });
    expect((screen.getByLabelText(/OpenAI 格式 端点地址/) as HTMLInputElement).value).toBe(
      "https://api.z.ai/api/paas/v4",
    );
    expect(screen.getByRole("img", { name: "预设待实测" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "zhipu" } });
    expect(screen.getByRole("img", { name: "预设已实测" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "官方接入文档" }).getAttribute("href"))
      .toBe("https://docs.bigmodel.cn/cn/guide/start/quick-start");
    fireEvent.change(select, { target: { value: "zhipu-coding" } });
    expect(screen.getByRole("link", { name: "官方接入文档" }).getAttribute("href"))
      .toBe("https://docs.bigmodel.cn/cn/coding-plan/quick-start");
  });

  it("exempts the current type from the verified gate when editing an existing provider", async () => {
    const api = makeApi(() => jsonResponse([{ ...provider, type: "moonshot" }]));
    render(<ProvidersPanel api={api} />);
    await openEditPage();
    const select = screen.getByLabelText(/供应商类型/, { selector: "select" }) as HTMLSelectElement;
    const optionValues = [...select.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value);
    // 编辑态豁免：已有类型仍可选（存量行不受门槛影响），但其他未验证 preset 依旧隐藏。
    expect(optionValues).toContain("moonshot");
    expect(optionValues).toContain("openai");
    expect(optionValues).not.toContain("deepseek");
    expect((select as HTMLSelectElement).value).toBe("moonshot");
  });

  it("shows a preset badge in the provider list", async () => {
    const api = makeApi(() => jsonResponse([{ ...provider, type: "moonshot" }]));
    render(<ProvidersPanel api={api} />);
    expect(await screen.findByText("Moonshot（月之暗面 Kimi）")).toBeTruthy();
  });

  it("links to the verified AgentPlan documentation from the provider list", async () => {
    const api = makeApi(() => jsonResponse([{ ...provider, type: "volcengine-plan" }]));
    render(<ProvidersPanel api={api} />);
    const link = await screen.findByRole("link", { name: /火山方舟 AgentPlan.*官方接入文档/ });
    expect(link.getAttribute("href")).toBe(
      "https://console.volcengine.com/ark/region:cn-beijing/docs/agent-plan-personal-get-started",
    );
    expect(screen.getByRole("img", { name: "预设已实测" }).nextElementSibling).toBe(link);
  });

  it("categorizes preset providers into the text tab (category source = preset.category)", async () => {
    const moonshot: ProviderRow = { ...provider, id: "p3", type: "moonshot" };
    const api = makeApi(() => jsonResponse([moonshot, provider]));
    render(<ProvidersPanel api={api} />);
    // moonshot 归文本语言类（preset.category 缺省 text）；custom 链路也归文本类。
    const tabs = await screen.findByRole("tablist", { name: "供应商" });
    const labels = [...tabs.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["全部", "文本语言"]);
  });

  it("hides the category tab bar only when the list is empty", async () => {
    const api = makeApi(() => jsonResponse([]));
    render(<ProvidersPanel api={api} />);
    await screen.findByText(/还没有供应商/);
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("ProvidersPanel dirty-close guard（#23）", () => {
  it("confirms before discarding a dirty draft on back; cancel keeps the page and the draft", async () => {
    const api = makeApi(() => jsonResponse([provider]));
    render(<ProvidersPanel api={api} />);
    await openEditPage();

    // 编辑名称 → Escape 关闭 → 脏守卫弹确认。
    fireEvent.change(screen.getByLabelText(/名称/, { selector: "input" }), { target: { value: "renamed-draft" } });
    fireEvent.keyDown(document, { key: "Escape" });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("未保存");

    // 取消 → 编辑页不关、草稿还在。
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(await screen.findByRole("region", { name: "openai" })).toBeTruthy();
    expect((screen.getByLabelText(/名称/, { selector: "input" }) as HTMLInputElement).value).toBe("renamed-draft");

    // 再 Escape → 确认 → 关闭且回列表、不残留弹窗。
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "openai" })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not prompt when nothing was edited", async () => {
    const api = makeApi(() => jsonResponse([provider]));
    render(<ProvidersPanel api={api} />);
    await openEditPage();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "openai" })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resets dirty after a successful save (epoch receipt)", async () => {
    let saved = false;
    const api = makeApi((url, init) => {
      if (init?.method === "PUT") {
        saved = true;
        return jsonResponse({ ...provider, name: "saved-name" });
      }
      return jsonResponse([saved ? { ...provider, name: "saved-name" } : provider]);
    });
    render(<ProvidersPanel api={api} />);
    await openEditPage();

    fireEvent.change(screen.getByLabelText(/名称/, { selector: "input" }), { target: { value: "saved-name" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    // 等保存回执（页面标题随列表刷新换名）——此时 saveEpoch 已提交、脏态已复位。
    await screen.findByRole("region", { name: "saved-name" });
    await act(async () => {}); // 冲刷 passive effect（脏复位）
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "saved-name" })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("guards the back button with a dirty draft", async () => {
    const api = makeApi(() => jsonResponse([provider]));
    render(<ProvidersPanel api={api} />);
    await openEditPage();

    const page = screen.getByRole("region", { name: "openai" });
    fireEvent.change(within(page).getByLabelText(/名称/, { selector: "input" }), { target: { value: "draft" } });

    // 脏态返回 → 先确认；取消后仍停在编辑页。
    fireEvent.click(within(page).getByRole("button", { name: "返回" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("region", { name: "openai" })).toBeTruthy();

    // 再返回并确认 → 落回列表态。
    fireEvent.click(within(screen.getByRole("region", { name: "openai" })).getByRole("button", { name: "返回" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "编辑 openai" })).toBeTruthy());
  });
});
