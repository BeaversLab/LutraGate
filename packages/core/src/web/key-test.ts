import type { Fetcher } from "../ports";
import { chatCompletionsUrl, type Protocol } from "@lutragate/shared";

/**
 * Key 级连通性测试（ticket 12 后续增强）：服务端解密 Key 后直接向供应商
 * 发一次最小 chat 请求——明文 Key 全程不出服务端（spec §3.4 的"解密仅
 * 发生在转发瞬间"原则延伸到测试路径）。
 */

export interface KeyTestInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 端点协议：openai（默认）→ /v1/chat/completions；anthropic → /v1/messages。 */
  protocol?: Protocol;
}

export interface KeyTestResult {
  ok: boolean;
  latencyMs: number;
  /** 失败原因（HTTP 错误或网络异常），成功时为空。 */
  error?: string;
  /** 成功时上游回复的内容预览。 */
  replyPreview?: string;
}

const TEST_TIMEOUT_MS = 15_000;

export async function runKeyTest(
  input: KeyTestInput,
  fetcher: Fetcher = { fetch: (req) => fetch(req) },
): Promise<KeyTestResult> {
  const protocol = input.protocol ?? "openai";
  const root = input.baseUrl.trim().replace(/\/+$/, "");
  const url =
    protocol === "anthropic" ? `${root}/v1/messages`
    : protocol === "gemini" ? `${root}/v1beta/models/${input.model}:generateContent`
    : protocol === "responses" ? `${root}/v1/responses`
    : chatCompletionsUrl(input.baseUrl);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (protocol === "anthropic") {
      headers["x-api-key"] = input.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (protocol === "gemini") {
      headers["x-goog-api-key"] = input.apiKey;
    } else {
      headers.authorization = `Bearer ${input.apiKey}`;
    }
    const bodyByProtocol: Record<string, unknown> = {
      openai: { model: input.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false },
      anthropic: { model: input.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false },
      gemini: { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
      responses: { model: input.model, input: "ping", max_output_tokens: 16 },
    };
    const resp = await fetcher.fetch(
      new Request(url, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify(bodyByProtocol[protocol]),
      }),
    );
    const latencyMs = Date.now() - startedAt;
    if (!resp.ok) {
      return { ok: false, latencyMs, error: await describeHttpError(resp) };
    }
    return { ok: true, latencyMs, replyPreview: await extractReplyPreview(resp) };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: aborted ? "请求超时（15 秒无响应）" : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function describeHttpError(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { error?: { message?: string } | string };
    const upstream = typeof body.error === "string" ? body.error : body.error?.message;
    if (upstream) return `HTTP ${resp.status}：${upstream}`;
  } catch {
    // 非 JSON 错误体
  }
  return `HTTP ${resp.status}`;
}

async function extractReplyPreview(resp: Response): Promise<string | undefined> {
  try {
    const body = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      content?: Array<{ type?: string; text?: string }>;
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const openai = body.choices?.[0]?.message?.content;
    if (typeof openai === "string") return openai.slice(0, 100);
    const anthropic = body.content?.find((b) => b.type === "text")?.text;
    if (typeof anthropic === "string") return anthropic.slice(0, 100);
    const gemini = body.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === "string")?.text;
    if (typeof gemini === "string") return gemini.slice(0, 100);
    const responses = body.output?.flatMap((o) => o.content ?? []).find((c) => typeof c.text === "string")?.text;
    return typeof responses === "string" ? responses.slice(0, 100) : undefined;
  } catch {
    return undefined;
  }
}
