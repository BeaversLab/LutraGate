import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { bucketAxisLabel, bucketTipLabel, pickLabelIndices, StackedBar, type StackedBarDatum } from "./StackedBar";

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe("pickLabelIndices", () => {
  it("returns every index when count fits maxLabels", () => {
    expect(pickLabelIndices(3, 7)).toEqual([0, 1, 2]);
  });

  it("samples evenly and always includes both ends", () => {
    const idx = pickLabelIndices(30, 7);
    expect(idx.length).toBe(7);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(29);
    // 相邻索引间隔均匀（±1）。
    const gaps = idx.slice(1).map((v, i) => v - idx[i]!);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it("handles degenerate inputs", () => {
    expect(pickLabelIndices(0, 7)).toEqual([]);
    expect(pickLabelIndices(5, 0)).toEqual([]);
    expect(pickLabelIndices(5, 1)).toEqual([0]); // maxLabels=1 不产 NaN
  });
});

describe("bucketAxisLabel", () => {
  const d = new Date(2026, 10, 12, 14, 5).getTime();
  it("formats day buckets as month/day", () => {
    expect(bucketAxisLabel(d, DAY)).toBe("11/12");
  });
  it("formats sub-day buckets as HH:mm", () => {
    expect(bucketAxisLabel(d, HOUR)).toBe("14:05");
  });
  it("tooltip label always carries month/day (sub-day buckets)", () => {
    expect(bucketTipLabel(d, HOUR)).toBe("11/12 14:05");
    expect(bucketTipLabel(d, DAY)).toBe("11/12");
  });
});

describe("StackedBar", () => {
  // 本地时区固定日期（裸 epoch 数字会随时区漂移）。
  const D1 = new Date(2026, 10, 10).getTime();
  const D2 = new Date(2026, 10, 11).getTime();
  const D3 = new Date(2026, 10, 12).getTime();
  const data: StackedBarDatum[] = [
    { start: D1, ok: 12, failed: 2 },
    { start: D2, ok: 17, failed: 0 },
    { start: D3, ok: 0, failed: 0 }, // 空桶不渲染
  ];

  function renderBar() {
    return render(
      <StackedBar
        data={data}
        bucketMs={DAY}
        formatTooltip={({ date, total, failed }) => `${date} · 共 ${total} 次 · 失败 ${failed}`}
      />,
    );
  }

  it("renders one bar group per non-empty bucket with ok and failed rects", () => {
    const { container } = renderBar();
    expect(container.querySelectorAll(".sb-group")).toHaveLength(2);
    expect(container.querySelectorAll(".sb-ok")).toHaveLength(2);
    // 失败为 0 的桶不画失败段。
    expect(container.querySelectorAll(".sb-fail")).toHaveLength(1);
  });

  it("shows the whole-sentence tooltip on hover, anchored to the bar", async () => {
    renderBar();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.mouseEnter(screen.getAllByText("", { selector: "g.sb-group" })[0]!);
    const tip = await screen.findByRole("status");
    expect(tip.textContent).toBe("11/10 · 共 14 次 · 失败 2");
  });
});
