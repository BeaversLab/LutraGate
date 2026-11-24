import type { ChatRequestBody } from "./proxy";

/**
 * Upstream usage extraction (ticket 08, PRD F4.1-F4.2): non-streaming
 * responses carry usage in the JSON body; streaming responses only carry it
 * in the final SSE chunk when stream_options.include_usage is set — the
 * gateway injects that flag and tolerates providers that omit usage anyway.
 */

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /**
   * 缓存命中（cache read）token 数，已含在 prompt_tokens 内，另列记录供展示：
   * Anthropic cache_read_input_tokens / OpenAI prompt_tokens_details.cached_tokens /
   * Gemini cachedContentTokenCount。
   */
  cached_tokens?: number;
}

/**
 * 兼容两种 usage 形状：OpenAI {prompt_tokens, completion_tokens} 与
 * Anthropic {input_tokens, output_tokens}。
 */
export function extractUsage(json: unknown): Usage | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const usage = (json as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const {
    prompt_tokens, completion_tokens, input_tokens, output_tokens,
    promptTokenCount, candidatesTokenCount,
    cache_read_input_tokens, cache_creation_input_tokens, cachedContentTokenCount,
  } = u;
  const details = u.prompt_tokens_details as { cached_tokens?: unknown } | null | undefined;
  const result: Usage = {};
  if (typeof prompt_tokens === "number") result.prompt_tokens = prompt_tokens;
  if (typeof completion_tokens === "number") result.completion_tokens = completion_tokens;
  if (typeof input_tokens === "number") result.prompt_tokens ??= input_tokens;
  if (typeof output_tokens === "number") result.completion_tokens ??= output_tokens;
  // Gemini 的 usageMetadata 键名
  if (typeof promptTokenCount === "number") result.prompt_tokens ??= promptTokenCount;
  if (typeof candidatesTokenCount === "number") result.completion_tokens ??= candidatesTokenCount;
  // 缓存命中（三种键名形态，取先出现者）。
  const cacheRead = typeof cache_read_input_tokens === "number" ? cache_read_input_tokens : undefined;
  const openAiCached = typeof details?.cached_tokens === "number" ? details.cached_tokens : undefined;
  const geminiCached = typeof cachedContentTokenCount === "number" ? cachedContentTokenCount : undefined;
  const cached = cacheRead ?? openAiCached ?? geminiCached;
  if (cached !== undefined) result.cached_tokens = cached;
  // Anthropic 原生 input_tokens 不含缓存读写 → 并回输入总量（OpenAI/Gemini 的
  // prompt_tokens/promptTokenCount 本就含缓存命中，再加会双计）。cache_creation
  // 是真实输入消耗（写缓存），同样并入；但不算「命中」，不进 cached_tokens。
  const cacheCreation =
    typeof cache_creation_input_tokens === "number" ? cache_creation_input_tokens : undefined;
  if ((cacheRead !== undefined || cacheCreation !== undefined) && result.prompt_tokens !== undefined) {
    result.prompt_tokens += (cacheRead ?? 0) + (cacheCreation ?? 0);
  }
  return result.prompt_tokens === undefined && result.completion_tokens === undefined
    ? undefined
    : result;
}

/** Ensure streaming requests ask the upstream for a final usage chunk. */
export function injectStreamOptions(body: ChatRequestBody): ChatRequestBody {
  if (body.stream !== true) return body;
  const existing = (body.stream_options ?? {}) as Record<string, unknown>;
  return { ...body, stream_options: { ...existing, include_usage: true } };
}

/**
 * Incremental SSE scanner: feed decoded chunks, it keeps the usage object
 * from the most recent data chunk that carries one. Tolerates malformed
 * JSON and missing usage.
 */
export class SseUsageScanner {
  private buffer = "";
  private found: Usage | undefined;

  push(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? ""; // keep the trailing partial line
    for (const line of lines) this.parseLine(line);
  }

  usage(): Usage | undefined {
    return this.found;
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice("data:".length).trim();
    if (payload.length === 0 || payload === "[DONE]") return;
    try {
      const event = JSON.parse(payload) as Record<string, unknown>;
      // OpenAI：usage 挂在 chunk 上；Anthropic：拆在 message_start（输入）
      // 与 message_delta（输出累计）两个事件里，需合并。
      if (event.type === "message_start") {
        const usage = extractUsage(event.message);
        if (usage?.prompt_tokens !== undefined) {
          this.found = { ...this.found, prompt_tokens: usage.prompt_tokens };
        }
        if (usage?.cached_tokens !== undefined) {
          this.found = { ...this.found, cached_tokens: usage.cached_tokens };
        }
        return;
      }
      if (event.type === "message_delta") {
        const usage = extractUsage(event);
        if (usage?.completion_tokens !== undefined) {
          this.found = { ...this.found, completion_tokens: usage.completion_tokens };
        }
        // 智谱 Anthropic 兼容端点：message_start 的 input_tokens 写死为 0，
        // 真实输入（含缓存字段）放在 message_delta——原生 Anthropic 的 delta
        // 不带这些字段，有则合并无则不动。
        if (usage?.prompt_tokens !== undefined) {
          this.found = { ...this.found, prompt_tokens: usage.prompt_tokens };
        }
        if (usage?.cached_tokens !== undefined) {
          this.found = { ...this.found, cached_tokens: usage.cached_tokens };
        }
        return;
      }
      // OpenAI Responses：usage 在 response.completed 事件的 response 里
      if (event.type === "response.completed") {
        const usage = extractUsage(event.response);
        if (usage) this.found = { ...this.found, ...usage };
        return;
      }
      const usage = extractUsage(event);
      if (usage) this.found = { ...this.found, ...usage };
    } catch {
      // malformed chunk — tolerate
    }
  }
}
