import type { SelectedChannel } from "../select-channel";
import { chatCompletionsUrl, responsesUrl, type Protocol } from "@lutragate/shared";

/**
 * OpenAI Chat Completions request rewriting and response forwarding
 * (spec §3.2, D7): replace the model name, inject the upstream
 * Authorization, strip hop-by-hop headers; stream SSE chunk-by-chunk and
 * buffer non-streaming responses.
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/** Client headers never forwarded upstream (replaced or recomputed). */
const STRIPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  "authorization", // gateway token must never leak upstream
  "content-length", // body is rebuilt with a new model name
]);

/** Upstream response headers never forwarded to the client. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  "content-length", // body may be re-buffered / re-chunked
  "content-encoding", // decoded by the runtime when read
]);

export interface ChatRequestBody {
  model: string;
  stream?: boolean;
  [key: string]: unknown;
}

export class InvalidBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBodyError";
  }
}

/** Validate the minimal shape we rely on; all other fields pass through. */
export function parseChatBody(json: unknown): ChatRequestBody {
  if (typeof json !== "object" || json === null) {
    throw new InvalidBodyError("request body must be a JSON object");
  }
  const { model, stream } = json as Record<string, unknown>;
  if (typeof model !== "string" || model.length === 0) {
    throw new InvalidBodyError('"model" must be a non-empty string');
  }
  if (stream !== undefined && typeof stream !== "boolean") {
    throw new InvalidBodyError('"stream" must be a boolean');
  }
  return json as ChatRequestBody;
}

function copyFilteredHeaders(source: Headers, stripped: Set<string>): Headers {
  const headers = new Headers();
  source.forEach((value, name) => {
    if (!stripped.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  });
  return headers;
}

export function buildUpstreamRequest(
  channel: SelectedChannel,
  body: ChatRequestBody,
  clientHeaders: Headers,
  plaintextKey: string,
): Request {
  const base = channel.provider.endpoints.openai;
  if (base === undefined) {
    throw new NoOpenAIEndpointError(channel.provider.name);
  }
  const headers = copyFilteredHeaders(clientHeaders, STRIPPED_REQUEST_HEADERS);
  headers.set("authorization", `Bearer ${plaintextKey}`);

  const url = chatCompletionsUrl(base);
  const upstreamBody = JSON.stringify({ ...body, model: channel.upstream_model });
  return new Request(url, {
    method: "POST",
    headers,
    body: upstreamBody,
  });
}

/** 该供应商未配置 OpenAI 格式端点（/v1/chat/completions 不可达）。 */
export class NoOpenAIEndpointError extends Error {
  constructor(providerName: string) {
    super(`provider "${providerName}" has no openai endpoint configured`);
    this.name = "NoOpenAIEndpointError";
  }
}

/** Anthropic Messages 请求体：只依赖 model/stream，其余字段原样透传。 */
export interface MessagesRequestBody {
  model: string;
  stream?: boolean;
  [key: string]: unknown;
}

export function parseMessagesBody(json: unknown): MessagesRequestBody {
  if (typeof json !== "object" || json === null) {
    throw new InvalidBodyError("request body must be a JSON object");
  }
  const { model, stream } = json as Record<string, unknown>;
  if (typeof model !== "string" || model.length === 0) {
    throw new InvalidBodyError('"model" must be a non-empty string');
  }
  if (stream !== undefined && typeof stream !== "boolean") {
    throw new InvalidBodyError('"stream" must be a boolean');
  }
  return json as MessagesRequestBody;
}

/**
 * 构建 Anthropic /v1/messages 上游请求：x-api-key 鉴权、透传
 * anthropic-version（缺省 2023-06-01）、剥离网关凭证。网关 token 永不外泄。
 */
export function buildAnthropicRequest(
  channel: SelectedChannel,
  body: MessagesRequestBody,
  clientHeaders: Headers,
  plaintextKey: string,
  search = "",
): Request {
  const base = channel.provider.endpoints.anthropic;
  if (base === undefined) {
    throw new NoAnthropicEndpointError(channel.provider.name);
  }
  const headers = copyFilteredHeaders(clientHeaders, STRIPPED_REQUEST_HEADERS);
  headers.delete("authorization"); // 网关 Bearer（若有）不得外泄；Anthropic 用 x-api-key
  headers.set("x-api-key", plaintextKey);
  if (!headers.has("anthropic-version")) {
    headers.set("anthropic-version", "2023-06-01");
  }

  // 客户端查询参数（如 ?beta=true）原样透传。
  const query = search.startsWith("?") ? search : search.length > 0 ? `?${search}` : "";
  const url = `${base.trim().replace(/\/+$/, "")}/v1/messages${query}`;
  const upstreamBody = JSON.stringify({ ...body, model: channel.upstream_model });
  return new Request(url, {
    method: "POST",
    headers,
    body: upstreamBody,
  });
}

/** 该供应商未配置 Anthropic 格式端点（/v1/messages 不可达）。 */
export class NoAnthropicEndpointError extends Error {
  constructor(providerName: string) {
    super(`provider "${providerName}" has no anthropic endpoint configured`);
    this.name = "NoAnthropicEndpointError";
  }
}

/** 通用：该供应商未配置指定协议的端点。 */
export class NoEndpointError extends Error {
  constructor(providerName: string, protocol: string) {
    super(`provider "${providerName}" has no ${protocol} endpoint configured`);
    this.name = "NoEndpointError";
  }
}

/**
 * Gemini 原生格式：模型名在 URL 路径里（/v1beta/models/{model}:method），
 * 网关按 upstream_model 重写路径；鉴权 x-goog-api-key，同时剥离客户端
 * 可能带来的 ?key= 查询参数（网关令牌不得外泄）。
 */
export function buildGeminiRequest(
  channel: SelectedChannel,
  method: "generateContent" | "streamGenerateContent",
  body: unknown,
  clientHeaders: Headers,
  plaintextKey: string,
  search: string,
): Request {
  const base = channel.provider.endpoints.gemini;
  if (base === undefined) {
    throw new NoEndpointError(channel.provider.name, "gemini");
  }
  const headers = copyFilteredHeaders(clientHeaders, STRIPPED_REQUEST_HEADERS);
  headers.delete("x-goog-api-key"); // 客户端侧的网关令牌不外泄
  headers.set("x-goog-api-key", plaintextKey);
  const root = base.trim().replace(/\/+$/, "");
  const url = `${root}/v1beta/models/${channel.upstream_model}:${method}${method === "streamGenerateContent" && !search.includes("alt=") ? "?alt=sse" : search}`;
  return new Request(url, {
    method: "POST",
    headers,
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}

/** OpenAI Responses 格式（/v1/responses）：model 在 body 中重写。 */
export function buildResponsesRequest(
  channel: SelectedChannel,
  body: ResponsesRequestBody,
  clientHeaders: Headers,
  plaintextKey: string,
): Request {
  const base = channel.provider.endpoints.responses;
  if (base === undefined) {
    throw new NoEndpointError(channel.provider.name, "responses");
  }
  const headers = copyFilteredHeaders(clientHeaders, STRIPPED_REQUEST_HEADERS);
  headers.set("authorization", `Bearer ${plaintextKey}`);
  const url = responsesUrl(base);
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, model: channel.upstream_model }),
  });
}

/** Responses 请求体：只依赖 model/stream，其余原样透传。 */
export interface ResponsesRequestBody {
  model?: string;
  stream?: boolean;
  [key: string]: unknown;
}

export function parseResponsesBody(json: unknown): ResponsesRequestBody & { model: string } {
  if (typeof json !== "object" || json === null) {
    throw new InvalidBodyError("request body must be a JSON object");
  }
  const { model, stream } = json as Record<string, unknown>;
  if (typeof model !== "string" || model.length === 0) {
    throw new InvalidBodyError('"model" must be a non-empty string');
  }
  if (stream !== undefined && typeof stream !== "boolean") {
    throw new InvalidBodyError('"stream" must be a boolean');
  }
  return json as ResponsesRequestBody & { model: string };
}

/** 从 Gemini 风格路径提取 (model, method)：/v1beta/models/{model}:{method} */
export function parseGeminiPath(pathname: string): { model: string; method: string } | null {
  const match = pathname.match(/^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
  return match ? { model: match[1]!, method: match[2]! } : null;
}

/**
 * Buffer a non-streaming upstream response (spec §3.2): fully read the body,
 * returning both the client Response and the decoded text so the caller can
 * extract usage without consuming the body twice.
 */
export async function forwardBuffered(
  upstream: Response,
): Promise<{ response: Response; text: string }> {
  const headers = copyFilteredHeaders(upstream.headers, STRIPPED_RESPONSE_HEADERS);
  const buf = await upstream.arrayBuffer();
  return {
    response: new Response(buf, { status: upstream.status, headers }),
    text: new TextDecoder().decode(buf),
  };
}

export interface StreamHooks {
  /** Called with each decoded chunk as it passes through. */
  onData?(text: string): void;
  /** Called once the stream has fully flushed. */
  onFlush?(): void;
  /** Called when the upstream stream errors or the client aborts. */
  onError?(reason: unknown): void;
}

/**
 * Pipe a streaming response chunk-by-chunk (PRD F1.5) without buffering;
 * hooks observe the stream for usage extraction and completion/abort
 * logging. Implemented with an explicit reader/wrapper stream —
 * TransformStream callbacks are not reliably invoked by some runtimes.
 */
export function forwardStreamed(upstream: Response, hooks: StreamHooks = {}): Response {
  const headers = copyFilteredHeaders(upstream.headers, STRIPPED_RESPONSE_HEADERS);
  const decoder = new TextDecoder();
  const reader = (upstream.body ?? new ReadableStream<Uint8Array>()).getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          hooks.onFlush?.();
          controller.close();
          return;
        }
        hooks.onData?.(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      } catch (err) {
        hooks.onError?.(err);
        controller.error(err);
      }
    },
    cancel(reason) {
      hooks.onError?.(reason);
      reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: upstream.status,
    headers,
  });
}
