import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EndpointTestRunner, type EndpointOutcome, type EndpointSpec } from "./EndpointTestRunner";

const specs: EndpointSpec[] = [{ protocol: "openai", baseUrl: "http://upstream.test/v1" }];

function renderRunner(run: (protocol: EndpointSpec["protocol"]) => Promise<EndpointOutcome>, modelCandidates?: string[]) {
  render(
    <EndpointTestRunner
      specs={specs}
      model=""
      onModelChange={() => {}}
      modelCandidates={modelCandidates}
      run={run}
    />,
  );
}

describe("EndpointTestRunner", () => {
  it("shows the outcome for a failing test", async () => {
    renderRunner(async () => ({ ok: false, latencyMs: 5, error: "HTTP 401" }));
    fireEvent.click(screen.getByRole("button", { name: "开始测试" }));
    await waitFor(() => {
      expect(screen.getByText(/连通失败/).textContent).toContain("HTTP 401");
    });
  });

  it("recovers from a rejected run instead of wedging on 测试中…", async () => {
    // 自托管宿主 Ollama 卡死实录回归：run 抛异常时 busy 必须复位、pending 落成失败。
    renderRunner(async () => {
      throw new Error("HTTP 400：pass { \"api_key\" } (min 4 chars)");
    });
    const button = screen.getByRole("button", { name: "开始测试" });
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByText(/连通失败/).textContent).toContain("min 4 chars");
    });
    const after = screen.getByRole("button", { name: "开始测试" });
    expect(after.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("测试中…")).toBeNull();
  });

  it("fills the model input from the candidates dropdown and allows re-picking", async () => {
    // datalist 原生缺陷回归：选中一项后再打开会按当前值过滤，无法换选——
    // 候选下拉恒回空位，可连续换选；输入框手输不受影响。
    const onModelChange = vi.fn();
    render(
      <EndpointTestRunner
        specs={specs}
        model=""
        onModelChange={onModelChange}
        modelCandidates={["glm-4.5", "glm-4-flash"]}
        run={async () => ({ ok: true, latencyMs: 1 })}
      />,
    );
    const select = screen.getByRole("combobox", { name: "候选模型" }) as HTMLSelectElement;
    expect((screen.queryByRole("combobox", { name: "候选模型" }) as HTMLSelectElement).value).toBe("");
    fireEvent.change(select, { target: { value: "glm-4-flash" } });
    expect(onModelChange).toHaveBeenCalledWith("glm-4-flash");
    // 回空位：选完不残留在下拉里（可再次打开换选其他项）。
    expect((screen.getByRole("combobox", { name: "候选模型" }) as HTMLSelectElement).value).toBe("");
    fireEvent.change(select, { target: { value: "glm-4.5" } });
    expect(onModelChange).toHaveBeenLastCalledWith("glm-4.5");
    // 手输路径不受下拉影响。
    fireEvent.change(screen.getByLabelText(/测试模型/), { target: { value: "my-fine-tune" } });
    expect(onModelChange).toHaveBeenLastCalledWith("my-fine-tune");
  });
});
