import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsBar } from "./SettingsBar";
import { ApiError, type AdminApi } from "../lib/api";

const EMPTY_DRAFT = { name: "", gatewayUrl: "", managementToken: "" };

/** 单环境（活跃）下的编辑表单渲染。 */
function renderSingle(props: Partial<Parameters<typeof SettingsBar>[0]> = {}) {
  const onSave = vi.fn();
  const onCreate = vi.fn();
  const onSwitch = vi.fn();
  const onDelete = vi.fn();
  render(
    <SettingsBar
      environments={[{ id: "e1", name: "家里" }]}
      activeEnvId="e1"
      initial={{ name: "家里", gatewayUrl: "http://home.test", managementToken: "lgm_home" }}
      onSave={onSave}
      onCreate={onCreate}
      onSwitch={onSwitch}
      onDelete={onDelete}
      {...props}
    />,
  );
  return { onSave, onCreate, onSwitch, onDelete };
}

describe("SettingsBar", () => {
  it("零环境（首启引导）直接进入新建模式并转发创建草稿", () => {
    const onCreate = vi.fn();
    render(
      <SettingsBar
        environments={[]}
        activeEnvId={null}
        initial={EMPTY_DRAFT}
        onSave={vi.fn()}
        onCreate={onCreate}
        onSwitch={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("http://localhost:8787"), { target: { value: "http://gw.test" } });
    fireEvent.change(screen.getByPlaceholderText("lgm_"), { target: { value: "lgm_tok" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    // 名字默认「默认」：上手路径与旧单份设置等长（multi-env 01）。
    expect(onCreate).toHaveBeenCalledWith({ name: "默认", gatewayUrl: "http://gw.test", managementToken: "lgm_tok" });
    // 首启没有可取消的目标：不渲染取消按钮。
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("常驻显示环境切换下拉（与侧栏同一控件），切换即转发目标环境", () => {
    const { onSwitch } = renderSingle({
      environments: [
        { id: "e1", name: "家里" },
        { id: "e2", name: "公司" },
      ],
    });

    const select = screen.getByRole("combobox", { name: "切换环境" }) as HTMLSelectElement;
    // 活跃环境即当前值（取代旧 chips 的 aria-selected 高亮口径）。
    expect(select.value).toBe("e1");
    expect([...select.querySelectorAll<HTMLOptionElement>("option")].map((o) => o.textContent)).toEqual(["家里", "公司"]);

    fireEvent.change(select, { target: { value: "e2" } });
    expect(onSwitch).toHaveBeenCalledWith("e2");
  });

  it("编辑模式保存活跃环境的改名/改地址（不触发创建/切换）", () => {
    const { onSave, onCreate, onSwitch } = renderSingle();

    // 环境切换下拉也含「家里」字样，名称输入按 label 定位避免歧义。
    fireEvent.change(screen.getByLabelText("环境名"), { target: { value: "家里新名" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledWith({
      name: "家里新名",
      gatewayUrl: "http://home.test",
      managementToken: "lgm_home",
    });
    expect(onCreate).not.toHaveBeenCalled();
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("新建第二个环境：进入创建模式、可取消回到活跃环境表单", () => {
    const { onCreate, onSave } = renderSingle({
      environments: [
        { id: "e1", name: "家里" },
        { id: "e2", name: "公司" },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "+ 新建环境" }));
    // 表单清空（名字回默认值），提示创建语义。
    expect(screen.getByText(/创建新环境/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("http://localhost:8787"), { target: { value: "http://work2.test" } });
    fireEvent.change(screen.getByPlaceholderText("lgm_"), { target: { value: "lgm_new" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    expect(onCreate).toHaveBeenCalledWith({ name: "默认", gatewayUrl: "http://work2.test", managementToken: "lgm_new" });
    expect(onSave).not.toHaveBeenCalled();

    // 取消：回到活跃环境的编辑表单（回填已保存值）。
    fireEvent.click(screen.getByRole("button", { name: "+ 新建环境" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
    expect((screen.getByLabelText("环境名") as HTMLInputElement).value).toBe("家里");
  });

  it("编辑模式提供删除入口（multi-env 04）：转发活跃环境 id，新建模式不显示", () => {
    const { onDelete } = renderSingle();

    fireEvent.click(screen.getByRole("button", { name: "删除环境" }));
    expect(onDelete).toHaveBeenCalledWith("e1");

    // 新建模式：破坏性入口不出现（先切到目标环境再删）。
    fireEvent.click(screen.getByRole("button", { name: "+ 新建环境" }));
    expect(screen.queryByRole("button", { name: "删除环境" })).toBeNull();
  });

  it("shows a persistent degraded-storage warning when the Keychain is unavailable (desktop 01)", () => {
    renderSingle({ secretDegraded: true });
    // 常驻警告：不可关闭，明示当前处于明文降级状态。
    expect(screen.getByRole("alert").textContent).toContain("明文降级存储");
  });

  it("提供 api 时显示服务器版本信息（标签 · 短 hash）；无 api（首启引导）不显示", async () => {
    // 首启引导：api 缺省 → 不渲染版本块（render 后由 auto-cleanup 卸载）。
    renderSingle();
    expect(screen.queryByText(/服务器版本/)).toBeNull();

    // 有 api：/version 注入信息 → 单行「标签 · 短 hash」，无提交明细列表。
    const api = {
      getVersion: async () => ({
        tag: "v1.3.0+1",
        commit: "9d62c6dfb3d4e0efe3c7d66ee94593adc4e5d800",
      }),
    } as unknown as AdminApi;
    render(
      <SettingsBar
        environments={[{ id: "e1", name: "家里" }]}
        activeEnvId="e1"
        initial={{ name: "家里", gatewayUrl: "http://home.test", managementToken: "lgm_home" }}
        onSave={vi.fn()}
        onCreate={vi.fn()}
        onSwitch={vi.fn()}
        onDelete={vi.fn()}
        api={api}
      />,
    );
    expect(await screen.findByText(/服务器版本：v1\.3\.0\+1 · 9d62c6d/)).toBeTruthy();
    expect(screen.queryByText("最近提交")).toBeNull();
  });

  it("api 拉 /version 失败（旧服务器 404）静默不显示版本块", async () => {
    const getVersion = vi.fn(async () => { throw new ApiError(404, "NOT_FOUND", "not found"); });
    render(
      <SettingsBar
        environments={[{ id: "e1", name: "家里" }]}
        activeEnvId="e1"
        initial={{ name: "家里", gatewayUrl: "http://home.test", managementToken: "lgm_home" }}
        onSave={vi.fn()}
        onCreate={vi.fn()}
        onSwitch={vi.fn()}
        onDelete={vi.fn()}
        api={{ getVersion } as unknown as AdminApi}
      />,
    );
    await waitFor(() => expect(getVersion).toHaveBeenCalled());
    expect(screen.queryByText(/服务器版本/)).toBeNull();
  });

  it("内嵌前端版本常显；桌面功能版本仅闭源壳注入时出现（open-core #36）", () => {
    // Web 形态：无 __lutragateDesktopVersion 注入 → 只显示内嵌前端版本。
    renderSingle();
    expect(screen.getByText(/内嵌前端：v/)).toBeTruthy();
    expect(screen.queryByText(/桌面功能/)).toBeNull();

    // 桌面形态：闭源 license bootstrap 注入全局（裸版本号，i18n 键补 v 前缀）→ 追加版本行。
    cleanup();
    (window as unknown as Record<string, unknown>).__lutragateDesktopVersion = "0.1.0";
    try {
      renderSingle();
      expect(screen.getByText("桌面功能：v0.1.0")).toBeTruthy();
      expect(screen.getByText(/内嵌前端：v/)).toBeTruthy();
    } finally {
      delete (window as unknown as Record<string, unknown>).__lutragateDesktopVersion;
    }
  });
});
