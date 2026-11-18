import { describe, expect, it } from "vitest";
import { extractBearer, timingSafeEqual } from "./auth";

function req(token?: string): Request {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://gw/v1/chat/completions", { method: "POST", headers });
}

describe("extractBearer", () => {
  it("extracts the token", () => {
    expect(extractBearer(req("secret"))).toBe("secret");
  });
  it("returns null when the header is missing or malformed", () => {
    expect(extractBearer(req())).toBeNull();
    const basic = new Request("http://gw/", { headers: { authorization: "Basic abc" } });
    expect(extractBearer(basic)).toBeNull();
    const empty = new Request("http://gw/", { headers: { authorization: "Bearer  " } });
    expect(extractBearer(empty)).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  it("accepts equal strings and rejects different ones", async () => {
    await expect(timingSafeEqual("tok", "tok")).resolves.toBe(true);
    await expect(timingSafeEqual("tok", "toc")).resolves.toBe(false);
    await expect(timingSafeEqual("", "x")).resolves.toBe(false);
    await expect(timingSafeEqual("", "")).resolves.toBe(true);
  });
});
