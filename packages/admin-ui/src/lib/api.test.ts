import { describe, expect, it } from "vitest";
import { AdminApi, ApiError, type FetchLike } from "./api";

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchSpy(responder: (url: string, init?: RequestInit) => Response): FetchLike & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return Object.assign(fn, { calls });
}

const opts = { baseUrl: "http://gw.test/", adminToken: "secret" };

describe("AdminApi", () => {
  it("sends the admin token and hits the expected paths", async () => {
    const fetcher = fetchSpy(() => jsonResp(200, []));
    const api = new AdminApi({ ...opts, fetcher });
    await api.listProviders();
    const call = fetcher.calls[0]!;
    expect(call.url).toBe("http://gw.test/admin/providers");
    expect(new Headers(call.init?.headers).get("x-admin-token")).toBe("secret");
  });

  it("returns parsed rows", async () => {
    const provider = { id: "p1", name: "a", base_url: "https://a.test", enabled: 1, weight: 1, created_at: 1, updated_at: 1 };
    const fetcher = fetchSpy(() => jsonResp(200, [provider]));
    await expect(new AdminApi({ ...opts, fetcher }).listProviders()).resolves.toEqual([provider]);
  });

  it("throws ApiError with the unified error structure on failure", async () => {
    const fetcher = fetchSpy(() => jsonResp(401, { error: { code: "UNAUTHORIZED", message: "missing or invalid admin token" } }));
    const api = new AdminApi({ ...opts, fetcher });
    const err = await api.listKeys().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toContain("admin token");
  });

  it("falls back to HTTP status when the error body is not JSON", async () => {
    const fetcher = fetchSpy(
      () => new Response("bad gateway", { status: 502, headers: { "content-type": "text/plain" } }),
    );
    const err = await new AdminApi({ ...opts, fetcher }).listMappings().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("HTTP 502");
  });

  it("serializes create/update bodies", async () => {
    const fetcher = fetchSpy(() => jsonResp(201, {}));
    await new AdminApi({ ...opts, fetcher }).createKey({ provider_id: "p1", api_key: "sk-1" });
    expect(fetcher.calls[0]!.url).toBe("http://gw.test/admin/keys");
    expect(fetcher.calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(fetcher.calls[0]!.init!.body as string)).toEqual({ provider_id: "p1", api_key: "sk-1" });
  });
});
