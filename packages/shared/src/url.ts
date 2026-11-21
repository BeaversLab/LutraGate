/**
 * 上游 chat/completions 路径拼接约定（跨适配器与测试路径共用）：
 *
 * - base_url 以 "/v<数字>" 结尾（如智谱 /api/paas/v4、火山方舟 /api/v3）：
 *   该路径段本身就是版本号，直接拼 "/chat/completions"；
 * - Gemini 兼容端点 "/v1beta/openai" 也已带版本；
 * - 其余（标准 OpenAI 兼容端点）拼 "/v1/chat/completions"。
 */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${openAiVersionedBase(baseUrl)}/chat/completions`;
}

/**
 * 上游模型列表端点（model-discovery）：与 chatCompletionsUrl 同一条版本段规则——
 * 版本化 base（/v<数字> 结尾，如智谱 /api/paas/v4、/api/coding/paas/v4）直接拼
 * "/models"，标准 base 拼 "/v1/models"。
 */
export function modelsListUrl(baseUrl: string): string {
  return `${openAiVersionedBase(baseUrl)}/models`;
}

/** Responses uses the same versioned Base URL convention as Chat Completions. */
export function responsesUrl(baseUrl: string): string {
  return `${openAiVersionedBase(baseUrl)}/responses`;
}

function openAiVersionedBase(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return /\/(?:v\d+|v1beta\/openai)$/.test(base) ? base : `${base}/v1`;
}
