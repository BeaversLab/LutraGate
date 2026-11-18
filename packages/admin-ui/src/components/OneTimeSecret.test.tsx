import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OneTimeSecret } from "./OneTimeSecret";

describe("OneTimeSecret (multi-user 06/08)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies the secret to the clipboard with visible feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <OneTimeSecret title="管理 Token" secret="lgm_secret-value" hint="交给用户本人。" onAck={() => {}} />,
    );
    expect(screen.getByText("lgm_secret-value")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith("lgm_secret-value");
    expect(await screen.findByText("已复制")).toBeTruthy();
  });

  it("cannot be dismissed by backdrop clicks — only by the explicit ack button", () => {
    render(<OneTimeSecret title="管理 Token" secret="lgm_secret-value" onAck={() => {}} />);
    // 误触遮罩（如复制时手滑点 outside）不应丢弃一次性凭证。
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(screen.getByText("lgm_secret-value")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /我已保存/ }));
    // onAck 由父组件负责清状态；这里确认按钮存在且可点即可（行为在面板测试覆盖）。
  });
});
