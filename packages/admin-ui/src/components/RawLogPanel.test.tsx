import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminApi, type AccessKeyRow, type Identity, type LogRow, type ProviderRow } from "../lib/api";
import { LogDb } from "../lib/logdb";
import { RawLogPanel } from "./RawLogPanel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const provider: ProviderRow = {
  id: "p1", name: "openai", type: "custom", endpoints: { openai: "https://a.test" }, enabled: 1, weight: 1, cooldown_failure_threshold: 0, cooldown_ms: 0, created_at: 1, updated_at: 1,
};

const accessKey: AccessKeyRow = {
  id: "k1", user_id: "u1", name: "coding", key_hint: "ab12", enabled: true,
  daily_token_limit: 0, daily_request_limit: 0, max_concurrency: 0,
  expires_at: 0, ip_allowlist: [], created_at: 1, updated_at: 1,
};

const USER_IDENTITY: Identity = { id: "u1", name: "alice", role: "user" };

const USERS = [
  { id: "u1", name: "alice", role: "user" as const, enabled: true, token_expires_at: 0, token_last_used_at: 0, token_hint: "", created_at: 1, updated_at: 1 },
  { id: "u2", name: "bob", role: "user" as const, enabled: true, token_expires_at: 0, token_last_used_at: 0, token_hint: "", created_at: 1, updated_at: 1 },
];

function log(id: string, ts: number, overrides: Partial<LogRow> = {}): LogRow {
  return {
    id, request_id: `req-${id}`, ts, client_model: "m1", upstream_model: null,
    provider_id: "p1", key_id: null, prompt_tokens: 10, completion_tokens: 5,
    latency_ms: 50, status: 200, error_type: null, error_message: null,
    user_id: "u1", access_key_id: "k1", ...overrides,
  };
}

const HOUR = 3_600_000;

/** 渲染 + 等待首屏数据（同步完成、行出现）。 */
async function renderPanel(rows: LogRow[], props: { selfOnly?: boolean; identity?: Identity } = {}) {
  const api = new AdminApi({
    baseUrl: "http://gw.test",
    adminToken: "t",
    fetcher: async (url) => {
      if (url.includes("/admin/logs")) return jsonResponse({ logs: rows, next_cursor: null });
      if (url.includes("/admin/access-keys")) return jsonResponse([accessKey]);
      if (url.includes("/admin/users")) return jsonResponse(USERS);
      return jsonResponse([provider]);
    },
  });
  const db = new LogDb(`rawlog-${Math.random().toString(36).slice(2)}`);
  await db.open();
  const utils = render(
    <RawLogPanel api={api} db={db} identity={props.identity ?? USER_IDENTITY} selfOnly={props.selfOnly} />,
  );
  return { ...utils, db };
}

function rowIds(): string[] {
  return Array.from(document.querySelectorAll("[data-testid='log-row']")).map(
    (el) => el.getAttribute("data-id")!,
  );
}

describe("RawLogPanel", () => {
  it("lists rows time-descending with pagination; prev/first page and last page edges hold", async () => {
    const now = Date.now();
    // 55 行（页大小 50）→ 2 页；id 编码时间序以便断言倒序。
    const rows = Array.from({ length: 55 }, (_, i) => log(`r${String(i).padStart(2, "0")}`, now - i * 1000));
    const { db } = await renderPanel(rows);

    // 第一页 = 最新 50 行、时间倒序（r00 = 最新在顶）。
    await waitFor(() => {
      expect(rowIds()).toHaveLength(50);
    });
    expect(rowIds()[0]).toBe("r00");
    expect(rowIds()[49]).toBe("r49");
    expect(screen.getByText(/第 1 \/ 2 页/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "上一页" }).hasAttribute("disabled")).toBe(true);

    // 末页：剩余 5 行，下一页禁用。
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => {
      expect(rowIds()).toHaveLength(5);
    });
    expect(rowIds()[0]).toBe("r50");
    expect(screen.getByText(/第 2 \/ 2 页/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "下一页" }).hasAttribute("disabled")).toBe(true);
    await db.delete();
  });

  it("filters by key and status code (desktop 05)", async () => {
    const now = Date.now();
    const rows = [
      log("a", now - HOUR, { access_key_id: "k1", status: 200 }),
      log("b", now - 2 * HOUR, { access_key_id: "k2", status: 502, error_type: "UPSTREAM_ERROR" }),
      log("c", now - 3 * HOUR, { access_key_id: null, status: 200 }),
    ];
    const { db } = await renderPanel(rows);
    await waitFor(() => {
      expect(rowIds()).toHaveLength(3);
    });

    // key 筛选：k2 → 只剩 b（无归属行 c 不命中任何 key）。
    fireEvent.change(screen.getByLabelText("场景 Key"), { target: { value: "k2" } });
    await waitFor(() => {
      expect(rowIds()).toEqual(["b"]);
    });

    // 状态码筛选（叠加）：200 下 k2 无命中 → 空。
    fireEvent.change(screen.getByLabelText("状态码"), { target: { value: "200" } });
    await waitFor(() => {
      expect(rowIds()).toEqual([]);
    });

    // 空结果提示（筛选态文案）+ 翻页边界不崩（0 页夹到第 1 页）。
    expect(screen.getByText(/没有匹配的日志/)).toBeTruthy();
    expect(screen.getByText(/第 1 \/ 1 页/)).toBeTruthy();

    // 回到全部 key + 200 → a、c。
    fireEvent.change(screen.getByLabelText("场景 Key"), { target: { value: "" } });
    await waitFor(() => {
      expect(rowIds()).toEqual(["a", "c"]);
    });
    await db.delete();
  });

  it("failed-only toggle + status badges + request-id truncation + reset filters", async () => {
    const now = Date.now();
    const rows = [
      log("a", now - HOUR, { status: 200 }),
      log("b", now - 2 * HOUR, { status: 502, error_type: "UPSTREAM_ERROR", request_id: "req_0123456789abcdefghijklmnopqrst" }),
      log("c", now - 3 * HOUR, { status: 404, error_type: "NO_MAPPING" }),
    ];
    const { db } = await renderPanel(rows);
    await waitFor(() => {
      expect(rowIds()).toHaveLength(3);
    });

    // 状态码三级配色：2xx 中性 / 4xx 警示 / 5xx 危险。
    const badgeOf = (id: string) => document.querySelector(`[data-id='${id}'] .log-status`)!.className;
    expect(badgeOf("a")).toContain("ok");
    expect(badgeOf("c")).toContain("err4");
    expect(badgeOf("b")).toContain("err5");

    // request_id 截断（title 保全值）；短 id 原样展示。textContent 含行内复制按钮文案，只断言截断 span。
    const reqTd = document.querySelector("[data-id='b'] td.mono") as HTMLElement;
    expect(reqTd.getAttribute("title")).toBe("req_0123456789abcdefghijklmnopqrst");
    expect(reqTd.querySelector("span")!.textContent).toBe("req_0123456789…qrst");
    expect(document.querySelector("[data-id='a'] td.mono span")!.textContent).toBe("req-a");

    // 仅失败：只剩 4xx/5xx 两行。
    fireEvent.click(screen.getByRole("button", { name: "仅失败" }));
    await waitFor(() => {
      expect(rowIds()).toEqual(["b", "c"]);
    });

    // 与状态码下拉叠加（502 + 仅失败 = b，语义诚实）。
    fireEvent.change(screen.getByLabelText("状态码"), { target: { value: "502" } });
    await waitFor(() => {
      expect(rowIds()).toEqual(["b"]);
    });

    // 一键重置（时间窗除外）：开关与下拉全回默认，三行齐回，按钮消失。
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    await waitFor(() => {
      expect(rowIds()).toHaveLength(3);
    });
    expect((screen.getByLabelText("状态码") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "重置筛选" })).toBeNull();
    await db.delete();
  });

  it("expands a failed row inline to show error type and message; success rows are not expandable", async () => {
    const now = Date.now();
    const rows = [
      log("ok", now - HOUR, { status: 200 }),
      log("bad", now - 2 * HOUR, {
        status: 502, error_type: "UPSTREAM_ERROR",
        error_message: "all 3 attempts failed; last error: 智谱 HTTP 500",
      }),
    ];
    const { db } = await renderPanel(rows);
    await waitFor(() => {
      expect(rowIds()).toHaveLength(2);
    });

    // 默认无展开；成功行点击无动作（不可展开）。
    expect(screen.queryByTestId("log-expand")).toBeNull();
    fireEvent.click(document.querySelector("[data-id='ok']") as HTMLElement);
    expect(screen.queryByTestId("log-expand")).toBeNull();

    // 失败行点开：错误类型徽标 + 详情摘要（error_message）都在展开行里。
    fireEvent.click(document.querySelector("[data-id='bad']") as HTMLElement);
    const expanded = await screen.findByTestId("log-expand");
    expect(expanded.textContent).toContain("UPSTREAM_ERROR");
    expect(expanded.textContent).toContain("last error: 智谱 HTTP 500");

    // 再点同一行收起。
    fireEvent.click(document.querySelector("[data-id='bad']") as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByTestId("log-expand")).toBeNull();
    });
    await db.delete();
  });

  it("shows a placeholder when an old row has no error_message, and copies the full request id inline", async () => {
    const now = Date.now();
    const rows = [
      log("old", now - HOUR, { status: 502, error_type: "UPSTREAM_ERROR" }),
      log("new", now - 2 * HOUR, {
        status: 503, error_type: "NO_CHANNEL:ALL_COOLDOWN",
        request_id: "req_0123456789abcdefghijklmnopqrst",
      }),
    ];
    const { db } = await renderPanel(rows);
    await waitFor(() => {
      expect(rowIds()).toHaveLength(2);
    });

    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } }); // jsdom 无实现，补桩

    // 旧行（无 error_message）：展开显示占位文案。
    fireEvent.click(document.querySelector("[data-id='old']") as HTMLElement);
    const expanded = await screen.findByTestId("log-expand");
    expect(expanded.textContent).toContain("没有错误详情");

    // request_id 行内复制：按钮送全值（列表里是截断显示）。
    fireEvent.click(screen.getByRole("button", { name: "复制 req_0123456789abcdefghijklmnopqrst" }));
    expect(writeText).toHaveBeenCalledWith("req_0123456789abcdefghijklmnopqrst");
    await waitFor(() => {
      expect(screen.getByText("已复制")).toBeTruthy();
    });
    await db.delete();
  });

  it("self view shows only the identity's rows; admin view shows all users with a user filter", async () => {
    const now = Date.now();
    const rows = [
      log("mine", now - HOUR, { user_id: "u1" }),
      log("other", now - 2 * HOUR, { user_id: "u2" }),
    ];

    // 我的入口：镜像混入他人行也只见自己。
    const mine = await renderPanel(rows, { selfOnly: true, identity: USER_IDENTITY });
    await waitFor(() => {
      expect(rowIds()).toEqual(["mine"]);
    });
    expect(screen.queryByLabelText("用户")).toBeNull(); // 我的入口无用户筛选
    mine.unmount();
    await mine.db.delete();

    // 管理入口：全量；用户筛选可圈定他人。
    const admin = await renderPanel(rows);
    await waitFor(() => {
      expect(rowIds()).toEqual(["mine", "other"]);
    });
    fireEvent.change(screen.getByLabelText("用户"), { target: { value: "u2" } });
    await waitFor(() => {
      expect(rowIds()).toEqual(["other"]);
    });
    await admin.db.delete();
  });

  it("exports the currently filtered rows as CSV via a Blob download (same criteria as the panel)", async () => {
    const now = Date.now();
    const rows = [log("a", now - HOUR, {}), log("b", now - 2 * HOUR, { status: 500 })];
    const { db } = await renderPanel(rows);
    await waitFor(() => {
      expect(rowIds()).toHaveLength(2);
    });

    // 圈定报错行后导出——CSV 只含当前筛选命中的原始行（同口径）。
    fireEvent.change(screen.getByLabelText("状态码"), { target: { value: "500" } });
    await waitFor(() => {
      expect(rowIds()).toEqual(["b"]);
    });

    const createObjectURL = vi.fn((_blob: Blob) => "blob:test");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL }); // jsdom 无实现，补桩

    fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0];
    // jsdom 的 Blob 无 .text() —— 走 FileReader 读回内容。
    const csv = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(csv).toContain("req-b"); // 命中行
    expect(csv).not.toContain("req-a"); // 被筛掉的行不导出
    expect(csv.split("\n")[0]).toContain("request_id"); // 全列表头（04 同一生成器）
    await db.delete();
  });

  it("renders an empty state without crashing when the mirror is empty", async () => {
    const { db } = await renderPanel([]);
    await waitFor(() => {
      expect(screen.getByText(/还没有日志/)).toBeTruthy();
    });
    expect(screen.getByText(/第 1 \/ 1 页/)).toBeTruthy();
    await db.delete();
  });
});
