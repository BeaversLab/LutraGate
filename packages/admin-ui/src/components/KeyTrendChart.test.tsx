import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AccessKeyRow, LogRow } from "../lib/api";
import { KeyTrendChart } from "./KeyTrendChart";

/** 按场景趋势图（desktop 04）：默认 top3、上限 8、指标切换、key 名解析展示。 */

const DAY = 86_400_000;

function ak(id: string, name: string): AccessKeyRow {
  return {
    id, user_id: "u1", name, key_hint: id.slice(-4), enabled: true,
    daily_token_limit: 0, daily_request_limit: 0, max_concurrency: 0,
    expires_at: 0, ip_allowlist: [], created_at: 1, updated_at: 1,
  };
}

function log(keyId: string, ts: number, tokens: number): LogRow {
  return {
    id: `${keyId}-${ts}`, request_id: "r", ts, client_model: "m1", upstream_model: null,
    provider_id: "p1", key_id: null, prompt_tokens: tokens, completion_tokens: tokens,
    latency_ms: 10, status: 200, error_type: null, user_id: "u1", access_key_id: keyId,
  };
}

function atLocalDay(offsetDays: number): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime() + offsetDays * DAY;
}

describe("KeyTrendChart", () => {
  const keys = [ak("k1", "写代码"), ak("k2", "聊天"), ak("k3", "翻译"), ak("k4", "搜索"), ak("k5", "other")];
  const logs = [
    log("k1", atLocalDay(0), 100),
    log("k1", atLocalDay(-1), 100),
    log("k2", atLocalDay(0), 10),
    log("k3", atLocalDay(-1), 10),
    log("k4", atLocalDay(0), 10),
    log("k5", atLocalDay(0), 10),
  ];
  const from = atLocalDay(-6);
  const to = atLocalDay(0) + 6 * 3_600_000;

  it("默认勾选请求数 top3 并在图例展示 key 名", () => {
    render(<KeyTrendChart logs={logs} keys={keys} from={from} to={to} />);
    // 默认 top3 = k1（2 次）、k2/k3/k4/k5 各 1 次中按名字序取两个。
    const legend = screen.getByTestId("key-trend").querySelector(".trend-legend")!;
    const items = [...legend.querySelectorAll(".legend-item")].map((n) => n.textContent);
    expect(items).toHaveLength(3);
    expect(items.some((t) => t!.includes("写代码（****k1）"))).toBe(true); // key 名 + 尾号解析展示
  });

  it("多选上限 8：第 9 把 key 勾选框禁用", () => {
    const many = Array.from({ length: 9 }, (_, i) => ak(`key-${i + 1}`, `k${i + 1}`));
    render(<KeyTrendChart logs={[]} keys={many} from={from} to={to} />);
    // 从默认 3 个开始补选到 8（空数据下按名字序排列，勾选框顺序即 key 顺序）。
    const boxes = screen.getAllByRole("checkbox");
    for (let i = 3; i <= 7; i++) fireEvent.click(boxes[i]!);
    const checkboxes = screen.getAllByRole("checkbox");
    const checked = checkboxes.filter((c) => (c as HTMLInputElement).checked);
    expect(checked.length).toBe(8);
    const unchecked = checkboxes.find((c) => !(c as HTMLInputElement).checked);
    expect((unchecked as HTMLInputElement).disabled).toBe(true);
  });

  it("指标切换：图例与折线在 requests/tokens 间切换", () => {
    render(<KeyTrendChart logs={logs} keys={keys} from={from} to={to} />);
    // requests：k1 = 2 次。
    const legend = () => screen.getByTestId("key-trend").querySelector(".trend-legend")!;
    expect([...legend().querySelectorAll(".legend-item")].some((n) => n.textContent!.includes("（****k1）：2 次"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
    // tokens：k1 每条 prompt+completion = 200 ×2 行 = 400。
    expect([...legend().querySelectorAll(".legend-item")].some((n) => n.textContent!.includes("400 tokens"))).toBe(true);
  });
});
