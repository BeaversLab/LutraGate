import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DetailAside, SplitLayout } from "./SplitDetail";

describe("SplitLayout", () => {
  it("renders list and aside side by side; aside=null collapses to list only", () => {
    const { container, rerender } = render(
      <SplitLayout list={<div>list-content</div>} aside={<div>aside-content</div>} />,
    );
    expect(screen.getByText("list-content")).toBeTruthy();
    expect(screen.getByText("aside-content")).toBeTruthy();
    expect(container.querySelector(".split-layout")!.className).toContain("with-aside");
    rerender(<SplitLayout list={<div>list-content</div>} aside={null} />);
    expect(screen.getByText("list-content")).toBeTruthy();
    expect(screen.queryByText("aside-content")).toBeNull();
    expect(container.querySelector(".split-layout")!.className).not.toContain("with-aside");
  });
});

describe("DetailAside", () => {
  it("moves focus in on open and restores it to the opener on close", () => {
    const opener = document.createElement("button");
    opener.textContent = "row";
    document.body.appendChild(opener);
    opener.focus();

    const onClose = vi.fn();
    const { unmount } = render(
      <DetailAside title="详情" onClose={onClose}>
        <p>body</p>
      </DetailAside>,
    );
    // 打开即焦点入 aside（关闭按钮，含可读 aria-label）。
    expect(document.activeElement?.getAttribute("aria-label")).toBe("关闭");
    unmount();
    // 关闭后焦点还原到打开前的元素（选中的列表行）。
    expect(document.activeElement).toBe(opener);
    document.body.removeChild(opener);
  });

  it("closes on Escape and via the close button", () => {
    const onClose = vi.fn();
    render(
      <DetailAside title="详情" onClose={onClose}>
        <p>body</p>
      </DetailAside>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
