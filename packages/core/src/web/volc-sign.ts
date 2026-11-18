/**
 * Volcengine IAM AK/SK 请求签名（provider-usage 02）：火山管控面 API 只认
 * Access Key 签名（方舟推理 API Key 对管控面无效），按官方 V4 规范实现
 * HMAC-SHA256 签名。规范对拍基准 = volcengine/volc-openapi-demos 官方示例
 * （raw-bytes 密钥链 kDate→kRegion→kService→kSigning；docs 页面「Hex 密钥」
 * 为表述歧义，官方 demo 一律 raw bytes）。
 *
 * 纯函数 + 注入时钟：测试断言中间串（CanonicalRequest / StringToSign）与
 * 请求头形态，固定输入必须确定性。
 */

/** RFC3986 百分号编码（encodeURIComponent 的 !'()* 也编码，空格 → %20）。 */
function rfc3986Encode(v: string): string {
  return encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)));
}

async function hmacSha256Hex(key: string | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

export interface VolcSignInput {
  method: string;
  /** 签名与 Host 头用（管控面域名，如 ark.cn-beijing.volcengineapi.com）。 */
  host: string;
  /** 请求路径（火山管控面通常为 "/"）。 */
  path?: string;
  /** Query 参数（Action/Version 等；按名 ASCII 排序进 CanonicalQueryString）。 */
  query: Record<string, string>;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 区域（方舟 = cn-beijing）。 */
  region?: string;
  /** 服务名（方舟管控面 = ark）。 */
  service?: string;
  /** 注入时钟（返回 UTC 时刻）；缺省 Date.now。 */
  now?: () => Date;
}

export interface VolcSignedRequest {
  headers: Record<string, string>;
  /** 仅供测试断言的中间串（不参与请求）。 */
  debug: {
    xDate: string;
    credentialScope: string;
    canonicalRequest: string;
    stringToSign: string;
    signedHeaders: string;
    signature: string;
  };
}

const VOLC_CONTENT_TYPE = "application/json";

/**
 * 计算签名并产出请求头（Authorization / X-Date / X-Content-Sha256 /
 * Content-Type / Host）。调用方把这些头合并进上游请求即可。
 */
export async function signVolcRequest(input: VolcSignInput): Promise<VolcSignedRequest> {
  const region = input.region ?? "cn-beijing";
  const service = input.service ?? "ark";
  const xDate = (input.now ?? (() => new Date()))()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, ""); // YYYYMMDDTHHMMSSZ
  const scopeDate = xDate.slice(0, 8);
  const payloadHash = await sha256Hex(input.body);

  // CanonicalQueryString：按参数名 ASCII 升序，RFC3986 编码。
  const canonicalQuery = Object.keys(input.query)
    .sort()
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(input.query[k]!)}`)
    .join("&");

  // CanonicalHeaders：小写名 + trim 值，按名字节序；host / x-date 必须在场。
  const signed = [
    ["content-type", VOLC_CONTENT_TYPE],
    ["host", input.host],
    ["x-content-sha256", payloadHash],
    ["x-date", xDate],
  ] as Array<[string, string]>;
  const canonicalHeaders = signed.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = signed.map(([k]) => k).join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path ?? "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${scopeDate}/${region}/${service}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  // 密钥链（raw bytes 逐级派生）：kDate=HMAC(SK, date) → kRegion → kService → HMAC(kService, "request")。
  const kDate = await hmacSha256Hex(input.secretAccessKey, scopeDate);
  const kRegion = await hmacSha256Hex(kDate, region);
  const kService = await hmacSha256Hex(kRegion, service);
  const kSigning = await hmacSha256Hex(kService, "request");
  const signature = hex(await hmacSha256Hex(kSigning, stringToSign));

  return {
    headers: {
      "content-type": VOLC_CONTENT_TYPE,
      host: input.host,
      "x-content-sha256": payloadHash,
      "x-date": xDate,
      authorization: `HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    debug: { xDate, credentialScope, canonicalRequest, stringToSign, signedHeaders, signature },
  };
}
