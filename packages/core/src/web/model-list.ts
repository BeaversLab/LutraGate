import type { Fetcher } from "../ports";
import { modelsListUrl, type Protocol } from "@lutragate/shared";

/**
 * 上游模型列表拉取（model-discovery 01）：服务端解密 Key 后 GET 供应商的
 * models 端点，解析各协议响应形。明文 Key 全程不出服务端（与 key-test 同缝）。
 * 失败返回 ok:false + 可读原因——管理面据此回落静态清单，不向用户报红。
 */

export interface ModelListResult {
  ok: boolean;
  /** 去重排序后的模型 id 列表（gemini 形的 "models/" 前缀已剥）。 */
  models: string[];
  error?: string;
}

const LIST_TIMEOUT_MS = 15_000;

/**
 * 模型列表条目可能携带的能力元数据（火山方舟 /api/v3/models 等会带任务/
 * 模态字段；字段名未在官方 OpenAI 兼容文档中固定，按常见命名容错）。
 * 仅在元数据**明确**表明非对话产出时剔除（视频/图像/3D/语音/嵌入），
 * 字段缺失一律保留 —— 保证纯 {id} 形列表（智谱等）行为不变。
 */
interface ModelEntry {
  id?: unknown;
  task_type?: unknown;
  task_types?: unknown;
  taskType?: unknown;
  TaskTypes?: unknown;
  domain?: unknown;
  domains?: unknown;
  Domains?: unknown;
  modalities?: { input?: unknown; output?: unknown };
  output_modalities?: unknown;
}

/** 归一化标签：小写去分隔符，便于跨命名风格比对（text_to_image ≈ TextToImage）。 */
const normTag = (v: unknown) => String(v).toLowerCase().replace(/[_-]/g, "");

/** 明确非对话的任务类型（生成/语音/嵌入类）。 */
const NON_CHAT_TASKS = new Set([
  "texttoimage", "imagetoimage", "imagegeneration",
  "texttovideo", "imagetovideo", "videogeneration",
  "textto3d", "imageto3d", "todgeneration",
  "texttospeech", "speechtotext", "speechtospeech", "asr", "tts",
  "textembedding", "imageembedding", "multimodalembedding", "embedding",
]);

function collectTags(...values: unknown[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    if (typeof value === "string") tags.push(normTag(value));
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") tags.push(normTag(item));
    }
  }
  return tags;
}

/** 输出模态（若条目未提供则 null = 未知，不据此剔除）。 */
function outputModalities(entry: ModelEntry): string[] | null {
  const fromModalities = entry.modalities && typeof entry.modalities === "object"
    ? entry.modalities.output
    : undefined;
  const source = fromModalities ?? entry.output_modalities;
  if (!Array.isArray(source) || source.length === 0) return null;
  return source.filter((m): m is string => typeof m === "string").map(normTag);
}

export function isNonChatModelEntry(entry: ModelEntry): boolean {
  // 输出模态明确 → 只看它：产出文本才是对话类（视觉理解模型输出文本，保留）。
  const outputs = outputModalities(entry);
  if (outputs !== null) return !outputs.includes("text");
  // 任务类型明确 → 任一命中对话/文本生成即保留，全部命中非对话集合才剔除。
  const tasks = collectTags(entry.task_type, entry.task_types, entry.taskType, entry.TaskTypes);
  if (tasks.length > 0) {
    const chatLike = tasks.some((t) => t === "chat" || t === "textgeneration" || t === "llm");
    if (chatLike) return false;
    return tasks.every((t) => NON_CHAT_TASKS.has(t));
  }
  // 领域只用来确认嵌入类（Embedding 域名明确）。
  const domains = collectTags(entry.domain, entry.domains, entry.Domains);
  return domains.length > 0 && domains.every((d) => d === "embedding");
}

export async function fetchUpstreamModels(
  input: { baseUrl: string; apiKey: string; protocol: Protocol; query?: Readonly<Record<string, string>> },
  fetcher: Fetcher = { fetch: (req) => fetch(req) },
): Promise<ModelListResult> {
  const base = input.baseUrl.trim().replace(/\/+$/, "");
  // OpenAI Chat 与 Responses 共用版本化的模型列表路径。
  const url =
    input.protocol === "anthropic" ? `${base}/v1/models`
    : input.protocol === "gemini" ? `${base}/v1beta/models`
    : modelsListUrl(input.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (input.protocol === "anthropic") {
      headers["x-api-key"] = input.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (input.protocol === "gemini") {
      headers["x-goog-api-key"] = input.apiKey;
    } else {
      headers.authorization = `Bearer ${input.apiKey}`;
    }
    const target = new URL(url);
    for (const [name, value] of Object.entries(input.query ?? {})) target.searchParams.set(name, value);
    const resp = await fetcher.fetch(new Request(target, { method: "GET", signal: controller.signal, headers }));
    if (!resp.ok) {
      let detail = "";
      try {
        const body = (await resp.json()) as { error?: { message?: string } | string };
        detail = typeof body.error === "string" ? body.error : (body.error?.message ?? "");
      } catch {
        // 非 JSON 错误体
      }
      return { ok: false, models: [], error: `HTTP ${resp.status}${detail ? `：${detail}` : ""}` };
    }
    const body = (await resp.json()) as {
      // openai / anthropic 共用 data[].id（可能带任务/模态元数据）
      data?: ModelEntry[];
      // gemini 原生形：models[].name 形如 "models/gemini-2.5-pro"
      models?: Array<{ name?: unknown }>;
    };
    const ids = input.protocol === "gemini"
      ? (body.models ?? []).map((m) => (typeof m.name === "string" ? m.name.replace(/^models\//, "") : ""))
      // 只保留对话类：剔除元数据明确为视频/图像/3D/语音/嵌入的条目（下拉/导入候选
      // 只服务 chat 路由；火山方舟 56 个模型里 22 个非对话类会淹没候选列表）。
      : (body.data ?? [])
          .filter((m) => !isNonChatModelEntry(m))
          .map((m) => (typeof m.id === "string" ? m.id : ""));
    const models = [...new Set(ids.filter((id) => id !== ""))].sort();
    return { ok: true, models };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      models: [],
      error: aborted ? "请求超时（15 秒无响应）" : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
