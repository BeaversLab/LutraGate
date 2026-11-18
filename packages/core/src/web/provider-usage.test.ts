import { describe, expect, it } from "vitest";
import type { Fetcher } from "../ports";
import { fetchVolcengineUsage, fetchZhipuUsage, type UsageResult } from "./provider-usage";
import { signVolcRequest } from "./volc-sign";

const T0 = 1_770_000_000_000; // 2026-02-02T00:00:00Z 附近，固定时钟

// ---- volc-sign：签名器中间串确定性（对拍官方 volc-openapi-demos 规范）----------

describe("signVolcRequest", () => {
  const input = {
    method: "POST",
    host: "ark.cn-beijing.volcengineapi.com",
    query: { Action: "GetAFPUsage", Version: "2024-01-01" },
    body: "{}",
    accessKeyId: "AKLT-example",
    secretAccessKey: "SK-example-secret",
    now: () => new Date(T0),
  };

  it("derives deterministic canonical request / string-to-sign / headers", async () => {
    const a = await signVolcRequest(input);
    const b = await signVolcRequest(input);
    // 固定输入 → 签名确定性（HMAC 链无随机源）。
    expect(a.debug.signature).toBe(b.debug.signature);
    expect(a.headers.authorization).toBe(b.headers.authorization);

    // X-Date：YYYYMMDDTHHMMSSZ（ISO8601 UTC，秒精度）。
    expect(a.debug.xDate).toMatch(/^\d{8}T\d{6}Z$/);
    // CredentialScope：date/cn-beijing/ark/request。
    expect(a.debug.credentialScope).toBe(`${a.debug.xDate.slice(0, 8)}/cn-beijing/ark/request`);
    // SignedHeaders：小写名字节序，host/x-date 必须在场。
    expect(a.debug.signedHeaders).toBe("content-type;host;x-content-sha256;x-date");
    // CanonicalHeaders 与 SignedHeaders 同序、以 \n 收尾；payload 哈希 = sha256("{}")。
    const emptyObjectHash = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    expect(a.headers["x-content-sha256"]).toBe(emptyObjectHash);
    expect(a.debug.canonicalRequest).toBe(
      [
        "POST",
        "/",
        "Action=GetAFPUsage&Version=2024-01-01",
        `content-type:application/json\nhost:ark.cn-beijing.volcengineapi.com\nx-content-sha256:${emptyObjectHash}\nx-date:${a.debug.xDate}\n`,
        "content-type;host;x-content-sha256;x-date",
        emptyObjectHash,
      ].join("\n"),
    );
    // StringToSign 四段：算法 / X-Date / scope / 哈希后的 CanonicalRequest。
    expect(a.debug.stringToSign.split("\n")).toHaveLength(4);
    expect(a.debug.stringToSign.split("\n")[0]).toBe("HMAC-SHA256");
    expect(a.headers.authorization).toBe(
      `HMAC-SHA256 Credential=AKLT-example/${a.debug.credentialScope}, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=${a.debug.signature}`,
    );
    // 金值对拍：本签名与独立参考实现（Python hmac/hashlib 链，与官方
    // volc-openapi-demos 同算法 raw-bytes 派生）对固定输入产出一致。
    expect(a.debug.stringToSign.split("\n")[3]).toBe("868726c01e089da009ff8fd15df3333e378249e7ec208f0e14675de97b4c6351");
    expect(a.debug.signature).toBe("4531952c44988dd8f0c263ca87dfd75114a5bdd69a2723c08586bfc2f261bb2e");
  });

  it("changes the signature when the secret key differs", async () => {
    const a = await signVolcRequest(input);
    const b = await signVolcRequest({ ...input, secretAccessKey: "SK-other" });
    expect(a.debug.signature).not.toBe(b.debug.signature);
  });
});

// ---- volcengine adapter：GetAFPUsage 解析 ---------------------------------------

function volcResult(windows: Record<string, unknown>, planType = "Large") {
  return { Result: { PlanType: planType, ...windows } };
}

function okFetcher(payload: unknown, seen?: Array<{ url: string; headers: Headers; body: string }>): Fetcher {
  return {
    async fetch(req) {
      seen?.push({ url: req.url, headers: req.headers, body: await new Response(req.body).text() });
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  };
}

const CREDS = { type: "volcengine_ak_sk" as const, access_key_id: "AKID", secret_access_key: "SKSECRET" };

describe("fetchVolcengineUsage", () => {
  it("POSTs the signed control-plane request and normalizes all four windows with AFP absolutes", async () => {
    const seen: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetcher = okFetcher(
      volcResult({
        AFPFiveHour: { Quota: "50.0", Used: "12.5", ResetTime: 1_770_006_800_000 },
        AFPDaily: { Quota: "80.0", Used: "8.0" },
        AFPWeekly: { Quota: "350.0", Used: "70.0", ResetTime: 1_770_090_000_000 },
        AFPMonthly: { Quota: "2000.0", Used: "850.5", ResetTime: 1_770_500_000_000 },
      }),
      seen,
    );
    const result: UsageResult = await fetchVolcengineUsage({ credentials: CREDS }, fetcher, () => T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.plan).toBe("Large");
    expect(result.usage.windows).toEqual([
      { key: "five_hour", label: "5 小时", percentage: 25, absolute: "12.5 / 50 AFP", reset_at: 1_770_006_800_000 },
      { key: "daily", label: "近 1 天", percentage: 10, absolute: "8 / 80 AFP" },
      { key: "weekly", label: "本周", percentage: 20, absolute: "70 / 350 AFP", reset_at: 1_770_090_000_000 },
      { key: "monthly", label: "本月", percentage: 43, absolute: "850.5 / 2000 AFP", reset_at: 1_770_500_000_000 },
    ]);
    expect(result.usage.fetched_at).toBe(T0);

    // 请求形态：管控面域名 + Action/Version query + 签名三头 + body "{}"。
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://ark.cn-beijing.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01");
    expect(seen[0]!.body).toBe("{}");
    expect(seen[0]!.headers.get("x-date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(seen[0]!.headers.get("authorization")).toContain("Credential=AKID/");
    expect(seen[0]!.headers.get("authorization")).toContain("/cn-beijing/ark/request");
  });

  it("skips missing/invalid windows instead of failing the whole payload", async () => {
    const fetcher = okFetcher(
      volcResult({
        AFPFiveHour: { Quota: "50.0", Used: "12.5" },
        // 无 AFPDaily / AFPWeekly（档位缺窗口）
        AFPMonthly: { Quota: "0.0", Used: "0.0" }, // 无效配额 → 跳过（防除零）
      }),
    );
    const result = await fetchVolcengineUsage({ credentials: CREDS }, fetcher, () => T0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.windows).toEqual([
      { key: "five_hour", label: "5 小时", percentage: 25, absolute: "12.5 / 50 AFP" },
    ]);
  });

  it("maps upstream 401 to a readable error carrying the control-plane message", async () => {
    const fetcher: Fetcher = {
      async fetch() {
        return new Response(
          JSON.stringify({ ResponseMetadata: { Error: { Message: "not authorized for action" } } }),
          { status: 401 },
        );
      },
    };
    const result = await fetchVolcengineUsage({ credentials: CREDS }, fetcher, () => T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("401");
    expect(result.error).toContain("not authorized for action");
  });

  it("returns kind=no_credentials without calling upstream when AK/SK are absent", async () => {
    let calls = 0;
    const fetcher: Fetcher = {
      async fetch() {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
    };
    const result = await fetchVolcengineUsage(
      { credentials: { type: "volcengine_ak_sk", access_key_id: "", secret_access_key: "" } },
      fetcher,
      () => T0,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("no_credentials");
    expect(calls).toBe(0); // 无凭证不打上游
  });

  it("rejects unrecognizable payloads with a subscription hint", async () => {
    const fetcher = okFetcher({ Result: {} });
    const result = await fetchVolcengineUsage({ credentials: CREDS }, fetcher, () => T0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("AgentPlan");
  });
});

// ---- 智谱 adapter 回归：与 01 一致的行为不变 --------------------------------------

describe("fetchZhipuUsage (01 regression)", () => {
  it("still normalizes TOKENS_LIMIT windows and bare-token auth", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetcher: Fetcher = {
      async fetch(req) {
        seen.push({ url: req.url, auth: req.headers.get("authorization") });
        return new Response(
          JSON.stringify({
            data: {
              level: "pro",
              limits: [
                { type: "TOKENS_LIMIT", percentage: 10, nextResetTime: 1_770_000_000_000 },
                { type: "TOKENS_LIMIT", percentage: 20, nextResetTime: 1_770_050_000_000 },
              ],
            },
          }),
          { status: 200 },
        );
      },
    };
    const result = await fetchZhipuUsage(
      { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", apiKey: "sk-1" },
      fetcher,
      () => T0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.windows.map((w) => w.key)).toEqual(["five_hour", "weekly"]);
    expect(seen[0]!.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(seen[0]!.auth).toBe("sk-1"); // 裸 token，无 Bearer
  });
});
