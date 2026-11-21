import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BootstrapPanel } from "./BootstrapPanel";

const identity = { id: "u-root", name: "root", role: "administrator" };
const issuedToken = "lgm_boot-once-1234";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function fill(placeholder: string, value: string) {
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
}

describe("BootstrapPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("locks the Web login address to the current origin", () => {
    render(<BootstrapPanel onDone={vi.fn()} />);
    const url = screen.getByLabelText("网关地址") as HTMLInputElement;
    expect(url.value).toBe(window.location.origin);
    expect(url.readOnly).toBe(true);
    expect(screen.queryByPlaceholderText("ADMIN_TOKEN")).toBeNull();
  });

  it("connects to an existing gateway on desktop with the address and user token", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ...identity, role: "user" }));
    vi.stubGlobal("fetch", fetchMock);
    const onDone = vi.fn();
    render(<BootstrapPanel desktop onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: /^我已有管理 Token/ }));
    fill("http://localhost:8787", "https://gateway.test/");
    click("继续");
    fill("lgm_", "lgm_user");
    click("验证并登录");

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(
      { name: "", gatewayUrl: "https://gateway.test", managementToken: "lgm_user" },
      { ...identity, role: "user" },
    ));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://gateway.test/admin/me");
  });

  it.each([false, true])("requires successful copying before login and pre-fills the issued token (desktop=%s)", async (desktop) => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("/users")
      ? jsonResponse({ ...identity, management_token: issuedToken }, 201)
      : jsonResponse(identity));
    vi.stubGlobal("fetch", fetchMock);
    const copy = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(undefined);
    vi.stubGlobal("navigator", Object.create(window.navigator, { clipboard: { value: { writeText: copy } } }));
    const onDone = vi.fn();
    const gatewayUrl = desktop ? "https://gateway.test" : window.location.origin;
    render(<BootstrapPanel desktop={desktop} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: /^首次初始化/ }));
    if (desktop) {
      fill("http://localhost:8787", gatewayUrl);
      click("继续");
    }
    fill("ADMIN_TOKEN", "bootstrap-admin-token");
    click("创建管理员");

    expect(await screen.findByText(issuedToken)).toBeTruthy();
    const next = screen.getByRole("button", { name: "继续" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    click("复制管理 Token");
    expect((await screen.findByRole("alert")).textContent).toMatch(/无法写入剪贴板/);
    expect(next.disabled).toBe(true);
    expect(onDone).not.toHaveBeenCalled();

    click("复制管理 Token");
    await screen.findByRole("button", { name: "已复制" });
    expect(copy).toHaveBeenLastCalledWith(issuedToken);
    expect(next.disabled).toBe(false);
    click("继续");
    const tokenInput = screen.getByPlaceholderText("lgm_") as HTMLInputElement;
    expect(tokenInput.value).toBe(issuedToken);
    expect(tokenInput.type).toBe("password");
    expect(screen.queryByText(issuedToken)).toBeNull();
    expect(onDone).not.toHaveBeenCalled();

    click("验证并登录");
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(
      { name: "", gatewayUrl, managementToken: issuedToken },
      identity,
    ));
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${gatewayUrl}/admin/users`);
    expect(request?.method).toBe("POST");
    expect((request?.headers as Record<string, string>)["x-admin-token"]).toBe("bootstrap-admin-token");
    expect(JSON.parse(request?.body as string).role).toBe("administrator");
  });

  it("keeps the administrator form open when the bootstrap token is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ error: { code: "UNAUTHORIZED", message: "bootstrap token invalid or already used" } }, 401),
    ));
    const onDone = vi.fn();
    render(<BootstrapPanel onDone={onDone} />);

    click("首次初始化");
    fill("ADMIN_TOKEN", "wrong-token");
    click("创建管理员");

    expect((await screen.findByRole("alert")).textContent).toContain("bootstrap token invalid");
    expect(screen.queryByRole("button", { name: "复制管理 Token" })).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });
});
