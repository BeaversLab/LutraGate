import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { contractRow } from "./lib/logstore.contract";
import { LogDb } from "./lib/logdb";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ADMIN_ME = { id: "u1", name: "root", role: "administrator" };

/** /admin/me 返回指定身份，其余列表端点返回空集合。 */
function fetchMockFor(me: unknown, meStatus = 200) {
  return vi.fn(async (url: string) => {
    if (url.includes("/admin/me")) return jsonResponse(me, meStatus);
    if (url.includes("/admin/logs")) return jsonResponse({ logs: [], next_cursor: null });
    return jsonResponse([]);
  });
}

/** 侧栏环境下拉（UI 2.0 #11）：与设置页 chips 同语义的一键切换入口。 */
function envSelect(): HTMLSelectElement {
  return screen.getByRole("combobox", { name: "环境" }) as HTMLSelectElement;
}

/** 切到指定名称的环境（等同旧 env-chips 点击）。 */
function switchEnv(name: string) {
  const select = envSelect();
  const option = [...select.querySelectorAll<HTMLOptionElement>("option")].find(
    (o) => o.textContent === name,
  );
  if (option === undefined) throw new Error(`env option not found: ${name}`);
  fireEvent.change(select, { target: { value: option.value } });
}

/** 进入侧栏底部「环境设置」页（SettingsBar 的增删改/凭证都在该页）。 */
function openSettings() {
  fireEvent.click(screen.getByRole("button", { name: "环境设置" }));
}

/** 首启引导：填写地址 + lgm_ 并创建第一个环境（名字默认「默认」，multi-env 01）。 */
async function saveCredentials() {
  fireEvent.change(screen.getByPlaceholderText("http://localhost:8787"), {
    target: { value: "http://localhost:8787" },
  });
  fireEvent.change(screen.getByPlaceholderText("lgm_"), {
    target: { value: "lgm_management-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
}

/** 环境设置页内的表单提交（编辑/新建环境）。环境名输入以 placeholder「默认」定位。 */
async function submitDraft(url: string, token: string, name: string | null = null, submit = "保存") {
  if (name !== null) {
    fireEvent.change(screen.getByPlaceholderText("默认"), { target: { value: name } });
  }
  fireEvent.change(screen.getByPlaceholderText("http://localhost:8787"), { target: { value: url } });
  fireEvent.change(screen.getByPlaceholderText("lgm_"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: submit }));
}

/** 可区分日志行（近 7 天窗口内）：复用契约工厂，id/provider/model 标环境。 */
function logRow(id: string, providerId: string, ts: number) {
  return contractRow(ts, {
    id,
    request_id: `req-${id}`,
    provider_id: providerId,
    client_model: `${providerId}-model`,
  });
}

/** 仪表盘统计卡取值（stat-label 的下一个兄弟即 stat-value）。 */
function statValue(label: string): string | null {
  return screen.getByText(label).nextElementSibling?.textContent ?? null;
}

/** 删除契约（multi-env 04）：本地库数据不可恢复。正常路径 = 库整个消失；
 * 已知竞态下（删除瞬间在途操作触发 Dexie 自动重开）可能复活一个空 schema
 * 孤儿库——multi-env 04 拍板可接受（数据已清、读取为空）。两种都算已清。 */
async function dbGoneOrEmpty(envId: string): Promise<boolean> {
  const name = `lutragate-${envId}`;
  const names = (await indexedDB.databases()).map((d) => d.name);
  if (!names.includes(name)) return true;
  const store = new LogDb(name);
  return (await store.listLogs()).length === 0 && (await store.maxTs()) === 0;
}

describe("App", () => {
  beforeEach(() => {
    // 多环境状态落 localStorage：跨用例隔离，每个用例从零环境首启。
    window.localStorage.clear();
  });

  it("prompts for settings when none are stored", () => {
    render(<App />);
    expect(screen.getByText(/请先填写网关地址与管理 Token/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "供应商" })).toBeNull();
    // 页脚同步条（UI 2.0 #11）：零环境无本地库 → 「尚未同步」措辞，不暗示在线状态。
    expect(screen.getByText("尚未同步本地日志")).toBeTruthy();
  });

  it("shows admin nav by default and switches to the personal perspective for a real-id administrator", async () => {
    vi.stubGlobal("fetch", fetchMockFor(ADMIN_ME));

    render(<App />);
    await saveCredentials();

    // 默认管理视角：管理导航齐全；个人面板不在导航（旧 showSelfTabs 语义拆成视角）。
    expect(await screen.findByRole("button", { name: "Key 管理" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "模型映射" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "用户与授权" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "日志" })).toBeTruthy();
    // 正式管理导航：网关总览 + 用量分析替代旧双入口。
    expect(screen.getByRole("button", { name: "网关总览" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "用量分析" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "流量图" })).toBeNull();
    expect(screen.queryByRole("button", { name: "管理仪表盘" })).toBeNull();
    expect(screen.queryByRole("button", { name: "我的 Key" })).toBeNull();

    // 视角切换按钮存在；切到个人视角 → 个人导航 + 落「我的仪表盘」。
    fireEvent.click(screen.getByRole("button", { name: "个人视角" }));
    expect(await screen.findByRole("button", { name: "我的 Key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "我的总览" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "我的用量分析" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "我的日志" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "可用模型" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "用户与授权" })).toBeNull();
    // 落点断言：个人视角首页 = 我的仪表盘（导航高亮 + 面板标题）。
    expect(screen.getByRole("heading", { name: "我的总览" })).toBeTruthy();

    // 切回管理视角：管理导航回归。
    fireEvent.click(screen.getByRole("button", { name: "管理视角" }));
    expect(await screen.findByRole("button", { name: "用户与授权" })).toBeTruthy();
    // 切回管理视角落网关总览。
    expect(await screen.findByRole("heading", { name: "网关总览" })).toBeTruthy();
    expect(document.querySelector(".graph-shell")).toBeNull();
    expect(screen.queryByRole("button", { name: "我的 Key" })).toBeNull();

    // 设置已持久化，重挂载后不再提示
    const { unmount } = render(<App />);
    unmount();
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByText(/请先填写网关地址与管理 Token/)).toBeNull();
    });

    vi.unstubAllGlobals();
  });

  it("renders the user-role view: own nav only, no perspective toggle (multi-user 07)", async () => {
    vi.stubGlobal("fetch", fetchMockFor({ id: "u2", name: "alice", role: "user" }));

    render(<App />);
    await saveCredentials();

    // user 角色只见自己的面板（含我的日志，desktop 05）。
    expect(await screen.findByRole("button", { name: "我的 Key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "我的总览" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "我的日志" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "可用模型" })).toBeTruthy();
    // 无任何全局面板入口，也不出现视角切换按钮（不暗示没有的权限）。
    expect(screen.queryByRole("button", { name: "日志" })).toBeNull();
    expect(screen.queryByRole("button", { name: "供应商" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Key 管理" })).toBeNull();
    expect(screen.queryByRole("button", { name: "用户与授权" })).toBeNull();
    expect(screen.queryByRole("button", { name: "管理视角" })).toBeNull();
    expect(screen.queryByRole("button", { name: "个人视角" })).toBeNull();

    vi.unstubAllGlobals();
  });

  it("hides the perspective toggle and self nav for a virtual administrator (no real user id)", async () => {
    vi.stubGlobal("fetch", fetchMockFor({ id: null, name: "virtual", role: "administrator" }));

    render(<App />);
    await saveCredentials();

    expect(await screen.findByRole("button", { name: "用户与授权" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "个人视角" })).toBeNull();
    expect(screen.queryByRole("button", { name: "我的 Key" })).toBeNull();

    vi.unstubAllGlobals();
  });

  it("shows an invalid-credential hint when /admin/me answers 401", async () => {
    vi.stubGlobal("fetch", fetchMockFor({ error: { code: "UNAUTHORIZED", message: "missing or invalid token" } }, 401));

    render(<App />);
    await saveCredentials();

    expect(await screen.findByText(/凭证无效/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "用户与授权" })).toBeNull();

    vi.unstubAllGlobals();
  });

  it("bootstraps the first environment into the multi-env store (multi-env 01)", async () => {
    vi.stubGlobal("fetch", fetchMockFor(ADMIN_ME));

    render(<App />);
    await saveCredentials();
    await screen.findByRole("button", { name: "Key 管理" });

    // 首启 = 创建第一个环境（名字默认「默认」）并置活跃；token 不进环境列表。
    const raw = JSON.parse(window.localStorage.getItem("lutragate.environments") ?? "null") as {
      environments: Array<{ id: string; name: string; gatewayUrl: string }>;
      activeEnvId: string;
    };
    expect(raw.environments).toHaveLength(1);
    const first = raw.environments[0]!;
    expect(first).toMatchObject({ name: "默认", gatewayUrl: "http://localhost:8787" });
    expect(raw.activeEnvId).toBe(first.id);

    // Web 路径：lgm_ 明文按环境分槽（spec 故事 14），旧单份设置键不写（不做存量迁移）。
    const tokens = JSON.parse(window.localStorage.getItem("lutragate.env-tokens") ?? "{}") as Record<string, string>;
    expect(tokens[first.id]).toBe("lgm_management-token");
    expect(window.localStorage.getItem("lutragate.settings")).toBeNull();

    vi.unstubAllGlobals();
  });

  it("switches between two environments pointing at two gateways (multi-env 02)", async () => {
    const HOME = "http://localhost:18787";
    const WORK = "http://localhost:28787";
    const calls: Array<{ url: string; token: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url, token: headers?.["x-admin-token"] ?? "" });
      // 两套假网关按端口区分身份：家里 = 管理员；公司 = user 角色（身份须按目标网关重验）。
      if (url.startsWith(HOME) && url.includes("/admin/me")) return jsonResponse(ADMIN_ME);
      if (url.startsWith(WORK) && url.includes("/admin/me")) return jsonResponse({ id: "u9", name: "workuser", role: "user" });
      if (url.includes("/admin/logs")) return jsonResponse({ logs: [], next_cursor: null });
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    // 环境 A「家里」：管理员视图，请求打家里网关、带家里的 lgm_。
    render(<App />);
    await submitDraft(HOME, "lgm_home", "家里", "创建");
    expect(await screen.findByRole("button", { name: "用户与授权" })).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith(HOME) && c.token === "lgm_home")).toBe(true);

    // 新建环境 B「公司」（环境设置页）：创建即切换 → 身份按公司网关重新验证；
    // 创建反馈走全局 toast。
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "+ 新建环境" }));
    await submitDraft(WORK, "lgm_work", "公司", "创建");
    await screen.findByText("已创建并切换到「公司」");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "用户与授权" })).toBeNull();
    });
    expect(await screen.findByRole("button", { name: "我的 Key" })).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith(WORK) && c.token === "lgm_work")).toBe(true);

    // 两套凭证长期共存：侧栏下拉切回家里 — 凭证仍在（重取 /admin/me 带原 lgm_）。
    switchEnv("家里");
    expect(await screen.findByRole("button", { name: "用户与授权" })).toBeTruthy();
    const homeMe = calls.filter((c) => c.url.startsWith(HOME) && c.url.includes("/admin/me"));
    expect(homeMe.at(-1)?.token).toBe("lgm_home");

    // 切换不删数据：两个环境的 lgm_ 分槽都还在，活跃标记指向家里。
    const tokens = JSON.parse(window.localStorage.getItem("lutragate.env-tokens") ?? "{}") as Record<string, string>;
    expect(Object.values(tokens).sort()).toEqual(["lgm_home", "lgm_work"]);
    const state = JSON.parse(window.localStorage.getItem("lutragate.environments") ?? "null") as {
      environments: Array<{ name: string }>;
      activeEnvId: string;
    };
    expect(state.environments.map((e) => e.name)).toEqual(["家里", "公司"]);

    vi.unstubAllGlobals();
  });

  it("isolates the per-env local mirrors: each gateway's logs land only in its own db (multi-env 03)", async () => {
    const HOME = "http://localhost:18787";
    const WORK = "http://localhost:28787";
    const now = Date.now();
    const homeLogs = [logRow("home-1", "home-provider", now - 1000), logRow("home-2", "home-provider", now - 2000)];
    const workLogs = [
      logRow("work-1", "work-provider", now - 1000),
      logRow("work-2", "work-provider", now - 2000),
      logRow("work-3", "work-provider", now - 3000),
    ];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/admin/me")) return jsonResponse(ADMIN_ME);
      if (url.includes("/admin/logs")) {
        const logs = url.startsWith(HOME) ? homeLogs : workLogs;
        return jsonResponse({ logs, next_cursor: null });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    // 环境 A「家里」：同步 2 条进家里的库。
    render(<App />);
    await submitDraft(HOME, "lgm_home", "家里", "创建");
    await waitFor(() => {
      expect(statValue("请求量")).toBe("2");
    });
    expect(screen.getByRole("button", { name: /同步说明：新增 2 条/ })).toBeTruthy();
    // 同步落库后页脚出现最近同步时间（SyncFooter 监听 LOG_SYNC_EVENT 刷新，放宽超时防事件时序偶发）。
    await waitFor(
      () => {
        expect(screen.getByText(/本地日志同步于/)).toBeTruthy();
      },
      { timeout: 4000 },
    );

    // 新建环境 B「公司」（创建即切换）：公司库从零同步 3 条，家里的 2 条不串进来。
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "+ 新建环境" }));
    await submitDraft(WORK, "lgm_work", "公司", "创建");
    await waitFor(() => {
      expect(statValue("请求量")).toBe("3");
    });

    // 切回家里：库还是那份（数据冻结后原样续在），公司日志不串入。
    switchEnv("家里");
    await waitFor(() => {
      expect(statValue("请求量")).toBe("2");
    });
    // 续传：从家里库的 maxTs 起拉，全部重复 → 新增 0（游标在各自库的 meta 里）。
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /同步说明：新增 0 条/ })).toBeTruthy();
    });

    vi.unstubAllGlobals();
  });

  it("a sync in flight during a switch lands only in its own env's db (multi-env 03, spec story 18)", async () => {
    const HOME = "http://localhost:18787";
    const WORK = "http://localhost:28787";
    const now = Date.now();
    const homeLogs = [logRow("home-1", "home-provider", now - 1000)];
    const workLogs = [logRow("work-1", "work-provider", now - 1000)];
    // 家里的首次日志响应可挂起（仅一次，避免切回后的同步永久卡死）：
    // 制造「同步在途时切换」的竞态窗口。
    let releaseHomeLogs: (() => void) | null = null;
    let hangNextHomeLogs = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/admin/me")) return jsonResponse(ADMIN_ME);
      if (url.includes("/admin/logs")) {
        if (url.startsWith(HOME)) {
          if (hangNextHomeLogs) {
            hangNextHomeLogs = false;
            await new Promise<void>((resolve) => {
              releaseHomeLogs = resolve;
            });
          }
          return jsonResponse({ logs: homeLogs, next_cursor: null });
        }
        return jsonResponse({ logs: workLogs, next_cursor: null });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    // 家里的首次同步挂起（logs 请求 pending）。
    render(<App />);
    await submitDraft(HOME, "lgm_home", "家里", "创建");
    await waitFor(() => {
      expect(releaseHomeLogs).not.toBeNull();
    });

    // 同步在途时切到公司：公司库只进公司的数据。
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "+ 新建环境" }));
    await submitDraft(WORK, "lgm_work", "公司", "创建");
    await waitFor(() => {
      expect(statValue("请求量")).toBe("1");
    });

    // 放行家里的在途响应：写入只能落进家里的库（spec：完成或作废，不串库）。
    releaseHomeLogs!();
    // 公司视图不受影响（无 home 行串入）。
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /同步说明：新增 1 条/ })).toBeTruthy();
    });
    expect(statValue("请求量")).toBe("1");

    // 切回家里：在途同步的行已冻结进家里的库，原样可见。
    switchEnv("家里");
    await waitFor(() => {
      expect(statValue("请求量")).toBe("1");
    });
    expect(document.querySelector(".io-recent")?.textContent).toContain("home-provider-model");

    vi.unstubAllGlobals();
  });

  it("deleting an environment wipes its credentials and local data; the other env is untouched (multi-env 04)", async () => {
    const HOME = "http://localhost:18787";
    const WORK = "http://localhost:28787";
    const now = Date.now();
    const homeLogs = [logRow("home-1", "home-provider", now - 1000)];
    const workLogs = [logRow("work-1", "work-provider", now - 1000), logRow("work-2", "work-provider", now - 2000)];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/admin/me")) return jsonResponse(ADMIN_ME);
      if (url.includes("/admin/logs")) {
        return jsonResponse({ logs: url.startsWith(HOME) ? homeLogs : workLogs, next_cursor: null });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    // 家里（1 条）+ 公司（2 条），公司为活跃。
    render(<App />);
    await submitDraft(HOME, "lgm_home", "家里", "创建");
    await waitFor(() => {
      expect(statValue("请求量")).toBe("1");
    });
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "+ 新建环境" }));
    await submitDraft(WORK, "lgm_work", "公司", "创建");
    await waitFor(() => {
      expect(statValue("请求量")).toBe("2");
    });
    const state = JSON.parse(window.localStorage.getItem("lutragate.environments") ?? "null") as {
      environments: Array<{ id: string; name: string }>;
    };
    const homeId = state.environments.find((e) => e.name === "家里")!.id;
    const workId = state.environments.find((e) => e.name === "公司")!.id;

    // 回归：侧栏下拉先切回家里再切到公司——切换不触发任何删除（两库仍在）。
    switchEnv("家里");
    await waitFor(() => {
      expect(statValue("请求量")).toBe("1");
    });
    switchEnv("公司");
    await waitFor(() => {
      expect(statValue("请求量")).toBe("2");
    });

    // 删除活跃的公司（环境设置页）：页内确认弹窗（window.confirm 在桌面 WKWebView
    // 静默返回 false），文案明示日志史不可恢复。
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "删除环境" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("删除环境「公司」？");
    expect(dialog.textContent).toContain("本地日志史将不可恢复");
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    // 删除反馈走全局 toast（UI 2.0 #11）。
    await screen.findByText("已删除环境「公司」");

    // 活跃回落家里：家里数据/凭证原样；公司从侧栏下拉消失。
    await waitFor(() => {
      expect(statValue("请求量")).toBe("1");
    });
    expect([...envSelect().querySelectorAll("option")].map((o) => o.textContent)).not.toContain("公司");

    // 公司的凭证分槽与本地库数据彻底清除；家里的保留。
    const after = JSON.parse(window.localStorage.getItem("lutragate.environments") ?? "null") as {
      environments: Array<{ id: string }>;
      activeEnvId: string;
    };
    expect(after.environments.map((e) => e.id)).toEqual([homeId]);
    expect(after.activeEnvId).toBe(homeId);
    await waitFor(() => {
      const tokens = JSON.parse(window.localStorage.getItem("lutragate.env-tokens") ?? "{}") as Record<string, string>;
      expect(tokens[workId]).toBeUndefined();
      expect(tokens[homeId]).toBe("lgm_home");
    });
    await waitFor(
      async () => {
        // 公司清空/消失（复活空库=已清口径）；家里的库原样保留。
        expect(await dbGoneOrEmpty(workId)).toBe(true);
        const names = (await indexedDB.databases()).map((d) => d.name);
        expect(names).toContain(`lutragate-${homeId}`);
      },
      // Dexie 删库需等旧连接 versionchange 关闭握手；全量跑时机器负载会拖慢握手，
      // 放宽默认 1s 防偶发（HEAD 既有 flake 的已知缓解）。
      { timeout: 5000 },
    );

    // 取消确认 = 不删任何东西（删除后环境回落，页面已重置 → 重新进环境设置页）。
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "删除环境" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    // 环境切换统一为下拉（侧栏 = 设置页同一控件）：取消删除后「家里」仍在环境列表。
    expect([...envSelect().querySelectorAll<HTMLOptionElement>("option")].some((o) => o.textContent === "家里")).toBe(true);
    expect(JSON.parse(window.localStorage.getItem("lutragate.environments")!).environments).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it("deleting the last environment returns to the bootstrap flow with everything wiped (multi-env 04)", async () => {
    vi.stubGlobal("fetch", fetchMockFor(ADMIN_ME));

    render(<App />);
    await submitDraft("http://localhost:18787", "lgm_home", "家里", "创建");
    await screen.findByRole("button", { name: "Key 管理" });
    const envId = (JSON.parse(window.localStorage.getItem("lutragate.environments")!) as {
      environments: Array<{ id: string }>;
    }).environments[0]!.id;

    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "删除环境" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "确认" }));

    // 空态 = 回到首启引导；设置与凭证分槽全空。
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "创建" })).toBeTruthy();
      expect(screen.getByText(/请先填写网关地址与管理 Token/)).toBeTruthy();
    });
    expect(JSON.parse(window.localStorage.getItem("lutragate.environments")!)).toEqual({
      environments: [],
      activeEnvId: null,
    });
    await waitFor(
      async () => {
        // 本地库也清（口径同上：不复存在，或竞态复活的空孤儿库）。
        expect(await dbGoneOrEmpty(envId)).toBe(true);
      },
      // Dexie 删库握手同上，放宽防偶发。
      { timeout: 5000 },
    );

    vi.unstubAllGlobals();
  });

  it("renames/re-points the active environment without losing id, credentials, or the active marker (multi-env 02)", async () => {
    vi.stubGlobal("fetch", fetchMockFor(ADMIN_ME));

    render(<App />);
    await submitDraft("http://localhost:18787", "lgm_home", "家里", "创建");
    await screen.findByRole("button", { name: "Key 管理" });

    // 环境设置页改名 + 改地址（id 与凭证不动）；保存反馈走全局 toast。
    openSettings();
    await submitDraft("http://localhost:28787", "lgm_home", "家里新名");
    await screen.findByText("环境设置已保存");
    await waitFor(() => {
      expect([...envSelect().querySelectorAll("option")].map((o) => o.textContent)).toContain("家里新名");
    });

    const state = JSON.parse(window.localStorage.getItem("lutragate.environments") ?? "null") as {
      environments: Array<{ id: string; name: string; gatewayUrl: string }>;
      activeEnvId: string;
    };
    expect(state.environments).toHaveLength(1);
    const only = state.environments[0]!;
    expect(only).toMatchObject({ name: "家里新名", gatewayUrl: "http://localhost:28787" });
    expect(state.activeEnvId).toBe(only.id);
    const tokens = JSON.parse(window.localStorage.getItem("lutragate.env-tokens") ?? "{}") as Record<string, string>;
    expect(tokens[only.id]).toBe("lgm_home");

    vi.unstubAllGlobals();
  });
});

