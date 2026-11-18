/**
 * 预置供应商目录（ticket 12 后续增强，参考 new-api 渠道类型预置表）。
 *
 * 收录标准与 spec D7 一致：官方提供 OpenAI Chat Completions 兼容端点
 * 的供应商。路径拼接见 url.ts 的 chatCompletionsUrl：标准端点配
 * {base}（拼 /v1/chat/completions），版本化端点配到版本段为止——智谱
 * GLM（/api/paas/v4）、火山方舟（/api/v3）按此收录。MiniMax 使用
 * chatcompletion_v2 命名（非 chat/completions 路径），待协议适配后
 * 再加入。管理端新增供应商时按类型选择，base_url 自动填充（仍可手
 * 改）；suggested_models 用于连通性测试与映射建议，非强制清单。
 */

export interface PresetProvider {
  /** 稳定标识，落库到 provider.type；自定义供应商为 "custom"。 */
  id: string;
  /** 中文显示名。 */
  label: string;
  /** 所属公司（同一公司多条 preset 在管理端树形分组用）；缺省 = 单独一家。 */
  vendor?: string;
  /** OpenAI 格式默认端点（不含 /v1 路径，网关转发时拼接）。 */
  base_url: string;
  /** Anthropic 格式默认端点（/v1/messages 直达；缺省表示该供应商不提供）。 */
  anthropic_base_url?: string;
  /** Gemini 原生格式端点（/v1beta/models/{model}:generateContent）。 */
  gemini_base_url?: string;
  /** OpenAI Responses 格式端点（/v1/responses）。 */
  responses_base_url?: string;
  /** 常用模型示例（用于连通性测试与映射建议）。 */
  suggested_models: string[];
  /**
   * 已验证（逐步放开制）：模型发现 / 连通性测试对该供应商真机实测通过。
   * 未验证的 preset 不出现在「新增供应商」类型下拉（编辑已有供应商不受限，
   * core 类型校验也仍认全量 id），真机验证一轮放开一条。
   */
  verified?: boolean;
  /** 本地自建部署（提示语不同）。 */
  self_hosted?: boolean;
  /**
   * 供应商分类（管理端列表分类标签栏用）：文本语言 / 生图 / 嵌入。
   * 缺省 = "text"（现有 preset 均为文本 LLM）；未来收录生图/嵌入类
   * preset 时显式标注，UI 按「有内容的分类才出标签」渲染。
   */
  category?: PresetCategory;
}

export type PresetCategory = "text" | "image" | "embedding";

/** 分类缺省值（现有 preset 均为文本 LLM，不逐条标 category）。 */
export function presetCategory(p: { category?: PresetCategory }): PresetCategory {
  return p.category ?? "text";
}

export const CUSTOM_PROVIDER_TYPE = "custom";

export const PRESET_PROVIDERS: PresetProvider[] = [
  {
    id: "openai",
    label: "OpenAI",
    base_url: "https://api.openai.com",
    responses_base_url: "https://api.openai.com",
    suggested_models: ["gpt-4o", "gpt-4o-mini", "o4-mini"],
  },
  {
    id: "google",
    label: "Google Gemini",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    gemini_base_url: "https://generativelanguage.googleapis.com",
    suggested_models: ["gemini-2.5-flash", "gemini-2.5-pro"],
  },
  {
    id: "anthropic",
    label: "Anthropic（Claude）",
    base_url: "https://api.anthropic.com",
    anthropic_base_url: "https://api.anthropic.com",
    suggested_models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
  },
  {
    id: "deepseek",
    label: "DeepSeek（深度求索）",
    base_url: "https://api.deepseek.com",
    anthropic_base_url: "https://api.deepseek.com/anthropic",
    suggested_models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "moonshot",
    label: "Moonshot（月之暗面 Kimi）",
    base_url: "https://api.moonshot.cn",
    anthropic_base_url: "https://api.moonshot.cn/anthropic",
    suggested_models: ["kimi-k2-0905-preview", "moonshot-v1-128k"],
  },
  {
    id: "groq",
    label: "Groq",
    base_url: "https://api.groq.com/openai",
    suggested_models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    base_url: "https://openrouter.ai/api",
    suggested_models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"],
  },
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    base_url: "https://api.siliconflow.cn",
    suggested_models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    vendor: "智谱",
    verified: true,
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    anthropic_base_url: "https://open.bigmodel.cn/api/anthropic",
    suggested_models: ["glm-4.5", "glm-4-flash"],
  },
  {
    // Coding Plan 专属网关（与通用 API 的 key/额度独立，不互通）：
    // chat 走 /api/coding/paas/v4；responses 真实路径为 /api/v1/responses，
    // 而网关拼 /v1/responses → 这里存到版本段之前（/api），见 proxy.ts responsesUrl。
    id: "zhipu-coding",
    label: "智谱 GLM Coding Plan",
    vendor: "智谱",
    verified: true,
    base_url: "https://open.bigmodel.cn/api/coding/paas/v4",
    anthropic_base_url: "https://open.bigmodel.cn/api/anthropic",
    responses_base_url: "https://open.bigmodel.cn/api",
    suggested_models: ["glm-4.7", "glm-4.6", "glm-4.5"],
  },
  {
    id: "volcengine",
    label: "火山方舟（豆包）",
    vendor: "火山引擎",
    verified: true,
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    suggested_models: ["doubao-pro-32k", "doubao-1.5-pro-32k"],
  },
  {
    // 编程套餐独立网关（AgentPlan / Coding Plan 共用 /api/plan 入口，与按量
    // 推理的 key/额度不互通）：openai 版本化 /api/plan/v3，anthropic 到版本段
    // 之前（/api/plan，代码拼 /v1/messages）。用量 adapter 与 volcengine 共用
    // （AK/SK 是 IAM 账号级，不分入口）。
    id: "volcengine-plan",
    label: "火山方舟 AgentPlan（编程套餐）",
    vendor: "火山引擎",
    verified: true,
    base_url: "https://ark.cn-beijing.volces.com/api/plan/v3",
    anthropic_base_url: "https://ark.cn-beijing.volces.com/api/plan",
    // 套餐实际可用清单（真机拉取回报；按输出顺序）。doubao/GLM/Kimi/DeepSeek 以
    // 统一模型 id 在该网关聚合提供，套餐外模型不可调。
    suggested_models: [
      "doubao-seed-evolving",
      "doubao-seed-2.1-pro",
      "doubao-seed-2.1-lite",
      "doubao-seed-2.0-mini",
      "kimi-k3.1-pro",
      "deepseek-v4.1-flash",
      "deepseek-v4.1-flash-economy",
      "glm-5.3",
      "glm-5.3-flash",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "kimi-k2.8-preview",
    ],
  },
  {
    id: "xai",
    label: "xAI（Grok）",
    base_url: "https://api.x.ai",
    suggested_models: ["grok-3", "grok-3-mini"],
  },
  {
    id: "mistral",
    label: "Mistral",
    base_url: "https://api.mistral.ai",
    suggested_models: ["mistral-large-latest", "ministral-8b-latest"],
  },
  {
    id: "perplexity",
    label: "Perplexity",
    base_url: "https://api.perplexity.ai",
    suggested_models: ["sonar", "sonar-pro"],
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    base_url: "http://host.docker.internal:11434",
    suggested_models: ["qwen2.5:7b", "llama3.1:8b"],
    self_hosted: true,
  },
  {
    id: "vllm",
    label: "vLLM / 兼容自建端点",
    base_url: "http://host.docker.internal:8000",
    suggested_models: [],
    self_hosted: true,
  },
];

export const PRESET_PROVIDER_IDS: readonly string[] = [
  CUSTOM_PROVIDER_TYPE,
  ...PRESET_PROVIDERS.map((p) => p.id),
];

export function findPresetProvider(id: string): PresetProvider | undefined {
  return PRESET_PROVIDERS.find((p) => p.id === id);
}

/** 新增供应商类型下拉可选集：已验证 preset（自定义选项由 UI 自行固定在最前）。 */
const VERIFIED_PRESET_PROVIDERS: readonly PresetProvider[] =
  PRESET_PROVIDERS.filter((p) => p.verified);

/**
 * 类型下拉可选集（编辑态豁免）：新增只看已验证；编辑额外放行当前供应商
 * 已有的类型——存量行无论是否验证都可继续编辑，但不引入新的未验证类型。
 */
export function selectablePresets(currentType?: string): readonly PresetProvider[] {
  if (!currentType) return VERIFIED_PRESET_PROVIDERS;
  const current = findPresetProvider(currentType);
  if (!current || current.verified) return VERIFIED_PRESET_PROVIDERS;
  return [...VERIFIED_PRESET_PROVIDERS, current];
}
