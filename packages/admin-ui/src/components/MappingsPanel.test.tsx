import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminApi, type MappingRow, type ProviderRow } from "../lib/api";
import { MappingsPanel } from "./MappingsPanel";

/** 列表平铺表（行选中进编辑整页）+ 新建/导入整页（DetailPage，对齐供应商/
 * Key 管理形态）+ 行内启用滑块。model-discovery 01 的表单交互语义零回退：
 * 供应商 → 上游模型（候选下拉实时/回落）→ 客户端模型预填；导入排除已有
 * client_model + 部分失败重试。 */

const provider: ProviderRow = {
  id: "p1",
  name: "智谱 GLM",
  type: "zhipu",
  endpoints: { openai: "https://open.bigmodel.cn/api/paas/v4" },
  enabled: 1,
  weight: 1,
  cooldown_failure_threshold: 0,
  cooldown_ms: 0,
  created_at: 1,
  updated_at: 1,
};
const mapping: MappingRow = {
  id: "m1",
  client_model: "glm-4.6",
  provider_id: "p1",
  upstream_model: "glm-4.6",
  enabled: 1,
};

function makeApi(
  modelsResponder: () => Response = () => new Response("{}", { status: 502 }),
  mappings: MappingRow[] = [],
): AdminApi {
  return new AdminApi({
    baseUrl: "http://gw.test",
    adminToken: "t",
    fetcher: async (url, init) => {
      if (url.endsWith("/admin/providers/p1/models")) return modelsResponder();
      if (url.endsWith("/admin/mappings") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "m-new" }), { status: 201 });
      }
      return new Response(JSON.stringify(url.includes("/admin/mappings") ? mappings : [provider]));
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function openCreatePage() {
  render(<MappingsPanel api={makeApi()} />);
  fireEvent.click(await screen.findByRole("button", { name: "新增映射" }));
  await screen.findByRole("region", { name: "新增映射" });
}

describe("MappingsPanel（列表 + 编辑整页）", () => {
  it("lists mappings flat with explicit alias/upstream columns", async () => {
    render(<MappingsPanel api={makeApi(undefined, [mapping])} />);
    const row = ((await screen.findAllByText("glm-4.6"))[0]!).closest("tr")!;
    // 两列语义：客户端别名与上游模型分列；别名语义并入标题下说明行（表下不再重复）。
    expect(row.textContent).toContain("智谱 GLM");
    expect(screen.getByText(/别名不代表厂商/)).toBeTruthy();
  });

  it("selecting a row opens the edit page prefilled; Escape closes (dirty guard)", async () => {
    render(<MappingsPanel api={makeApi(undefined, [mapping])} />);
    const row = ((await screen.findAllByText("glm-4.6"))[0]!).closest("tr")!;
    (row as HTMLElement).focus();
    fireEvent.click(row);
    const page = await screen.findByRole("region", { name: "glm-4.6" }); // 页标题 = 客户端别名
    // 编辑回填：上游与客户端模型名。
    expect((screen.getByLabelText(/上游模型名/) as HTMLInputElement).value).toBe("glm-4.6");
    expect((screen.getByLabelText(/客户端模型名/) as HTMLInputElement).value).toBe("glm-4.6");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("返回");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    // 保存后编辑页保持打开（选中即编辑）；重新查询而非引用旧节点。
    await waitFor(() => expect(screen.getByRole("region", { name: "glm-4.6" })).toBeTruthy());

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "glm-4.6" })).toBeNull());
    expect(page).toBeTruthy();
  });

  it("toggles via the row switch without opening the edit page; delete lives on the edit page", async () => {
    const confirm = vi.fn();
    vi.stubGlobal("confirm", confirm);
    let deleted = false;
    let toggled = false;
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url, init) => {
        if (init?.method === "PUT") { toggled = true; return jsonResponse({ ...mapping, enabled: 0 }); }
        if (init?.method === "DELETE") { deleted = true; return jsonResponse({ deleted: true }); }
        return jsonResponse(
          url.includes("/admin/mappings") ? (deleted ? [] : toggled ? [{ ...mapping, enabled: 0 }] : [mapping]) : [provider],
        );
      },
    });
    render(<MappingsPanel api={api} />);

    // 行内滑块启停：aria-label 翻转（启用→停用动作语义），不开编辑页。
    const switchInput = (await screen.findByRole("checkbox", { name: "停用" })) as HTMLInputElement;
    expect(switchInput.checked).toBe(true);
    fireEvent.click(switchInput);
    await waitFor(() => expect((screen.getByRole("checkbox", { name: "启用" }) as HTMLInputElement).checked).toBe(false));
    expect(screen.queryByRole("region")).toBeNull();

    // 删除：进编辑页，页内二次确认弹窗，文案含 别名 → 供应商/上游模型。
    const row = ((await screen.findAllByText("glm-4.6"))[0]!).closest("tr")!;
    fireEvent.click(row);
    await screen.findByRole("region", { name: "glm-4.6" });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("删除映射「glm-4.6 → 智谱 GLM/glm-4.6」？");
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
    expect(confirm).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("sorts rows by client alias so channels of the same alias sit adjacent", async () => {
    const m2: MappingRow = { id: "m2", client_model: "zeta", provider_id: "p1", upstream_model: "zeta", enabled: 1 };
    const m3: MappingRow = { id: "m3", client_model: "glm-4.6", provider_id: "p1", upstream_model: "glm-4.6-air", enabled: 1 };
    render(<MappingsPanel api={makeApi(undefined, [m2, mapping, m3])} />);
    await screen.findAllByText("zeta");
    const aliases = [...document.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent);
    // 同别名相邻（无分组结构）：glm-4.6 两行聚齐后才是 zeta。
    expect(aliases).toEqual(["glm-4.6", "glm-4.6", "zeta"]);
  });

  it("filters rows by search across alias/provider/upstream, with a distinct empty state", async () => {
    const m2: MappingRow = { id: "m2", client_model: "zeta", provider_id: "p1", upstream_model: "zeta", enabled: 1 };
    render(<MappingsPanel api={makeApi(undefined, [mapping, m2])} />);
    await screen.findAllByText("zeta");

    // 命中供应商名（智谱）→ 两行都在；命中上游模型（zeta）→ 只剩 zeta。
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "智谱" } });
    expect(document.querySelectorAll("tbody tr td:first-child").length).toBe(2);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zeta" } });
    const aliases = [...document.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent);
    expect(aliases).toEqual(["zeta"]);

    // 无命中 → 专属空态（区别于「还没有映射」）。
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nope" } });
    expect(screen.getByText("没有匹配的映射。")).toBeTruthy();
  });

  it("opens the create page and submits a new mapping", async () => {
    const posts: unknown[] = [];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url, init) => {
        if (url.endsWith("/admin/mappings") && init?.method === "POST") {
          posts.push(JSON.parse(init!.body as string));
          return jsonResponse({ id: "m-new" }, 201);
        }
        return jsonResponse(url.includes("/admin/mappings") ? [] : [provider]);
      },
    });
    render(<MappingsPanel api={api} />);
    // 新建在前、从上游导入在其旁。
    const createBtn = await screen.findByRole("button", { name: "新增映射" });
    const importBtn = screen.getByRole("button", { name: "从上游导入" });
    expect(createBtn.compareDocumentPosition(importBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(createBtn);
    await screen.findByRole("region", { name: "新增映射" });

    fireEvent.change(screen.getByLabelText(/上游模型名/), { target: { value: "glm-4.6" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => {
      expect(posts).toEqual([{ client_model: "glm-4.6", provider_id: "p1", upstream_model: "glm-4.6" }]);
    });
    // 新建成功回落列表态。
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
  });
});

describe("MappingsPanel mapping form (model-discovery 01, edit page)", () => {
  it("orders fields provider first, upstream second, client third; client prefilles with the upstream name", async () => {
    await openCreatePage();

    // 字段顺序：供应商 → 上游模型名 → 客户端模型名（spec 拍板）。
    const providerSelect = screen.getByLabelText(/供应商/);
    const upstream = screen.getByLabelText(/上游模型名/);
    const client = screen.getByLabelText(/客户端模型名/) as HTMLInputElement;
    expect(providerSelect.compareDocumentPosition(upstream) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(upstream.compareDocumentPosition(client) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 上游选中 → 客户端预填同名。
    fireEvent.change(upstream, { target: { value: "glm-4.6" } });
    expect(client.value).toBe("glm-4.6");
  });

  it("stops prefilling once the client model name is manually edited", async () => {
    await openCreatePage();
    const upstream = screen.getByLabelText(/上游模型名/);
    const client = screen.getByLabelText(/客户端模型名/) as HTMLInputElement;
    fireEvent.change(upstream, { target: { value: "glm-4.6" } });
    fireEvent.change(client, { target: { value: "my-alias" } });
    fireEvent.change(upstream, { target: { value: "glm-4.7" } });
    expect(client.value).toBe("my-alias"); // 手动编辑后不再跟随
  });

  it("renders candidates as a combo select (datalist-free) and refills from upstream, falling back to preset suggestions", async () => {
    // 实时列表路径：候选下拉来自上游模型列表，选中回填输入框（datalist 原生
    // 缺陷——选中后再打开按当前值过滤无法换选——以恒回空位的 select 替代）。
    const { unmount } = render(
      <MappingsPanel api={makeApi(() => jsonResponse({ provider_id: "p1", protocol: "openai", models: ["glm-4.6", "glm-4.7"] }))} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "新增映射" }));
    await waitFor(() => expect(screen.getByText(/来自上游模型列表/)).toBeTruthy());
    const upstream = screen.getByLabelText(/上游模型名/) as HTMLInputElement;
    expect(upstream.getAttribute("list")).toBeNull(); // 不再挂 datalist
    const candidates = screen.getByRole("combobox", { name: /候选/ }) as HTMLSelectElement;
    expect(Array.from(candidates.options).map((o) => o.value)).toEqual(["", "glm-4.6", "glm-4.7"]);
    fireEvent.change(candidates, { target: { value: "glm-4.7" } });
    expect(upstream.value).toBe("glm-4.7");
    // 恒回空位：可连续换选。
    fireEvent.change(candidates, { target: { value: "glm-4.6" } });
    expect(upstream.value).toBe("glm-4.6");
    unmount();

    // 拉取失败 → 回落预设静态清单（zhipu → glm-4.5 等）。
    render(<MappingsPanel api={makeApi()} />);
    fireEvent.click(await screen.findByRole("button", { name: "新增映射" }));
    await waitFor(() => expect(screen.getByText(/预设清单/)).toBeTruthy());
  });
});

describe("MappingsPanel import from upstream (model-discovery 01, edit page)", () => {
  it("imports selected upstream models as client_model=upstream_model, excluding existing client_models", async () => {
    const posts: unknown[] = [];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url, init) => {
        if (url.endsWith("/admin/providers/p1/models")) {
          return jsonResponse({ provider_id: "p1", protocol: "openai", models: ["glm-4.6", "glm-4.7", "glm-4.5-air"] });
        }
        if (url.endsWith("/admin/mappings") && init?.method === "POST") {
          posts.push(JSON.parse(init!.body as string));
          return jsonResponse({ id: "m-new" }, 201);
        }
        return jsonResponse(url.includes("/admin/mappings") ? [mapping] : [provider]);
      },
    });
    render(<MappingsPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "从上游导入" }));
    const page = await screen.findByRole("region", { name: "从上游导入映射" });
    await waitFor(() => expect(screen.getByText(/来自上游模型列表/)).toBeTruthy());
    // 来源标注 + 排除说明。
    expect(page.textContent).toContain("已排除该供应商下已有的 client_model");

    // 已排除该供应商下已有 client_model（glm-4.6）——页内无候选，仅在列表里。
    expect(page.textContent).not.toContain("glm-4.6");
    expect(screen.getAllByText("glm-4.7").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "glm-4.7" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "glm-4.5-air" }));
    fireEvent.click(screen.getByRole("button", { name: "导入所选（2）" }));

    await waitFor(() => {
      expect(posts).toEqual([
        { client_model: "glm-4.7", provider_id: "p1", upstream_model: "glm-4.7" },
        { client_model: "glm-4.5-air", provider_id: "p1", upstream_model: "glm-4.5-air" },
      ]);
    });
  });

  it("falls back to preset suggestions, reports partial failures and retries only the failed models", async () => {
    const posted: string[] = [];
    const api = new AdminApi({
      baseUrl: "http://gw.test",
      adminToken: "t",
      fetcher: async (url, init) => {
        if (url.endsWith("/admin/providers/p1/models")) {
          return new Response("{}", { status: 502 }); // 上游不可用 → 回落预设清单
        }
        if (url.endsWith("/admin/mappings") && init?.method === "POST") {
          const body = JSON.parse(init!.body as string);
          posted.push(body.client_model);
          if (body.client_model === "glm-4.5") {
            return jsonResponse({ error: { code: "CONFLICT", message: "mapping ... exists" } }, 409);
          }
          return jsonResponse({ id: "m-new" }, 201);
        }
        return jsonResponse(url.includes("/admin/mappings") ? [] : [provider]);
      },
    });
    render(<MappingsPanel api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "从上游导入" }));
    await screen.findByRole("region", { name: "从上游导入映射" });
    await waitFor(() => expect(screen.getByText(/预设清单/)).toBeTruthy()); // zhipu → glm-4.5 / glm-4-flash

    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: /导入所选/ }));
    // 部分失败不静默：保留页面并展示失败明细（统一错误文案取 message，非错误码）。
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("失败 1 条"));
    expect(screen.getByRole("alert").textContent).toContain("mapping ... exists");
    expect(screen.getByRole("region", { name: "从上游导入映射" })).toBeTruthy();

    // 成功项已移出候选：再次导入只重试失败项，不重复提交已建映射。
    fireEvent.click(screen.getByRole("button", { name: /导入所选/ }));
    await waitFor(() => expect(posted).toEqual(["glm-4.5", "glm-4-flash", "glm-4.5"]));
    expect(screen.queryByText("glm-4-flash", { selector: ".import-candidates .mono" })).toBeNull();
  });
});
