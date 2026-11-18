import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdminApi, type KeyRow } from "../lib/api";
import { earliestResetAt, formatFetchedAgo, formatResetAt, KeyUsageCell, usageFillClass } from "./KeyUsageCell";

const NOW = 1_770_000_600_000; // 固定「现在」，供相对时间断言

function zhipuKey(id = "pu1"): KeyRow {
  return {
    id,
    provider_id: "prov-zhipu",
    key_hint: "cret",
    enabled: 1,
    cooldown_until: 0,
    failure_count: 0,
    daily_token_limit: 0,
    daily_request_limit: 0,
    created_at: 1,
    updated_at: 1,
  };
}

function usageBody(providerId = "pu1") {
  return {
    key_id: providerId,
    provider_type: "zhipu-coding",
    plan: "pro",
    windows: [
      { key: "five_hour", label: "5 小时", percentage: 42, reset_at: NOW + 2 * 3600_000 },
      { key: "weekly", label: "本周", percentage: 95 },
      { key: "mcp_monthly", label: "MCP（月）", percentage: 7 },
    ],
    fetched_at: NOW - 5 * 60_000,
  };
}

function makeApi(responder: (url: string, init?: RequestInit) => Response): AdminApi {
  return new AdminApi({ baseUrl: "http://gw.test", adminToken: "t", fetcher: async (url, init) => responder(url, init) });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("provider usage helpers", () => {
  it("classifies fill color by threshold (70 warn / 90 danger)", () => {
    expect(usageFillClass(42)).toBe("usage-fill");
    expect(usageFillClass(70)).toBe("usage-fill warn");
    expect(usageFillClass(89)).toBe("usage-fill warn");
    expect(usageFillClass(90)).toBe("usage-fill danger");
  });

  it("formats relative ages and reset countdowns", () => {
    expect(formatFetchedAgo(NOW - 30_000, NOW)).toBe("刚刚");
    expect(formatFetchedAgo(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
    expect(formatFetchedAgo(NOW - 2 * 3600_000, NOW)).toBe("2 小时前");
    expect(formatResetAt(NOW + 90_000, NOW)).toBe("2 分钟后重置");
    expect(formatResetAt(NOW + 3 * 3600_000, NOW)).toBe("3 小时后重置");
    expect(formatResetAt(NOW + 5 * 86_400_000, NOW)).toBe("5 天后重置");
    expect(formatResetAt(NOW - 1, NOW)).toBe("即将重置");
  });

  it("picks the earliest reset time and returns null when none present", () => {
    expect(earliestResetAt([{ reset_at: NOW + 5 }, { reset_at: NOW + 1 }, {}])).toBe(NOW + 1);
    expect(earliestResetAt([{}])).toBeNull();
    expect(earliestResetAt([])).toBeNull();
  });
});

describe("KeyUsageCell", () => {
  it("renders normalized windows as quota bars with plan, data age and reset countdown", async () => {
    const api = makeApi((url) => {
      expect(new URL(url).pathname).toBe("/admin/keys/pu1/usage");
      return jsonResponse(usageBody());
    });
    render(<KeyUsageCell api={api} keyRow={zhipuKey()} providerType="zhipu-coding" now={() => NOW} />);
    expect(await screen.findByText("pro")).toBeTruthy();
    expect(screen.getByText("5 小时").textContent).toBe("5 小时");
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("95%")).toBeTruthy();
    expect(screen.getByText("7%")).toBeTruthy();
    expect(screen.getByText(/5 分钟前/).textContent).toContain("5 分钟前");
    expect(screen.getByText(/2 小时后重置/)).toBeTruthy();
    // 阈值染色：本周 95% → danger。
    const weekly = screen.getByTestId("usage-fill-weekly");
    expect(weekly.className).toBe("usage-fill danger");
  });

  it("renders nothing for unsupported provider types without fetching", () => {
    const calls: string[] = [];
    const api = makeApi((url) => {
      calls.push(url);
      return jsonResponse({});
    });
    const { container } = render(
      <KeyUsageCell api={api} keyRow={{ ...zhipuKey("pu-custom"), id: "pu-custom" }} providerType="custom" now={() => NOW} />,
    );
    expect(container.textContent).toBe("");
    expect(calls).toHaveLength(0); // 不支持的类型不发请求
  });

  it("shows a gray '用量不可用' with the upstream reason on failure", async () => {
    const api = makeApi(() => jsonResponse({ error: { code: "UPSTREAM_ERROR", message: "智谱返回 HTTP 401：令牌错误" } }, 502));
    render(<KeyUsageCell api={api} keyRow={zhipuKey("pu-fail")} providerType="zhipu-coding" now={() => NOW} />);
    expect(await screen.findByText(/用量不可用：智谱返回 HTTP 401/)).toBeTruthy();
  });

  it("treats a server USAGE_UNSUPPORTED rejection as invisible", async () => {
    const api = makeApi(() =>
      jsonResponse({ error: { code: "USAGE_UNSUPPORTED", message: 'usage not supported for provider type "zhipu-coding"' } }, 400),
    );
    const { container } = render(<KeyUsageCell api={api} keyRow={zhipuKey("pu-unsup")} providerType="zhipu-coding" now={() => NOW} />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("re-fetches with refresh=1 when the refresh button is pressed", async () => {
    const urls: string[] = [];
    const api = makeApi((url) => {
      const u = new URL(url);
      urls.push(u.pathname + u.search);
      return jsonResponse(usageBody("pu-refresh"));
    });
    render(<KeyUsageCell api={api} keyRow={zhipuKey("pu-refresh")} providerType="zhipu-coding" now={() => NOW} />);
    await screen.findByText("42%");
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(urls).toEqual(["/admin/keys/pu-refresh/usage", "/admin/keys/pu-refresh/usage?refresh=1"]));
    expect(screen.getByText("42%")).toBeTruthy();
  });

  it("renders AFP absolute annotations on windows (volcengine)", async () => {
    const api = makeApi(() =>
      jsonResponse({
        key_id: "pu-volc",
        provider_type: "volcengine",
        plan: "Large",
        windows: [
          { key: "five_hour", label: "5 小时", percentage: 25, absolute: "12.5 / 50 AFP", reset_at: NOW + 3600_000 },
          { key: "monthly", label: "本月", percentage: 43, absolute: "850.5 / 2000 AFP" },
        ],
        fetched_at: NOW - 60_000,
      }),
    );
    render(<KeyUsageCell api={api} keyRow={zhipuKey("pu-volc")} providerType="volcengine" now={() => NOW} />);
    expect(await screen.findByText("12.5 / 50 AFP")).toBeTruthy();
    expect(screen.getByText("850.5 / 2000 AFP")).toBeTruthy();
    expect(screen.getByText("Large")).toBeTruthy();
  });

  it("shows the AK/SK setup hint with a working action on USAGE_NO_CREDENTIALS", async () => {
    const api = makeApi(() =>
      jsonResponse({ error: { code: "USAGE_NO_CREDENTIALS", message: "this provider has no management credentials" } }, 400),
    );
    const onSetup = vi.fn();
    render(
      <KeyUsageCell api={api} keyRow={zhipuKey("pu-guide")} providerType="volcengine" onSetupCredentials={onSetup} now={() => NOW} />,
    );
    expect(await screen.findByText("填写 AK/SK 以启用用量查询")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "去填写" }));
    expect(onSetup).toHaveBeenCalledTimes(1);
    // 引导态不渲染「刷新」（没有可刷新的数据）。
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
  });

  it("serves a cached body without re-fetching on remount", async () => {
    const urls: string[] = [];
    const api = makeApi((url) => {
      urls.push(new URL(url).pathname);
      return jsonResponse(usageBody("pu-cache"));
    });
    const first = render(<KeyUsageCell api={api} keyRow={zhipuKey("pu-cache")} providerType="zhipu-coding" now={() => NOW} />);
    await screen.findByText("42%");
    first.unmount();
    render(<KeyUsageCell api={api} keyRow={zhipuKey("pu-cache")} providerType="zhipu-coding" now={() => NOW} />);
    expect(screen.getByText("42%")).toBeTruthy(); // 缓存直出
    await waitFor(() => expect(urls).toHaveLength(1)); // 不重拉
    expect(urls[0]).toBe("/admin/keys/pu-cache/usage");
  });
});
