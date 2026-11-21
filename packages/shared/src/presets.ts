/**
 * 预置供应商目录（ticket 12 后续增强，参考 new-api 渠道类型预置表）。
 *
 * 官方文档确认的 API 端点可先开放给用户联调。普通 API 与套餐、
 * 国内与国际站分预设保存，联调通过后独立标记 verified。
 */

export interface PresetProvider {
  /** 稳定标识，落库到 provider.type；自定义供应商为 "custom"。 */
  id: string;
  /** 中文显示名。 */
  label: string;
  /** 所属公司（同一公司多条 preset 在管理端树形分组用）；缺省 = 单独一家。 */
  vendor?: string;
  /** OpenAI 格式默认 Base URL。既可包含官方版本段，也可使用标准根路径。 */
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
   * 未完成真机验证的条目若有官方文档，则在新增时标为待实测。
   */
  verified?: boolean;
  /** 官方调用规范，同时用于将已核对的预设开放给用户联调。 */
  documentation_url?: string;
  /** 官方文档覆盖的模型发现协议。空数组表示使用静态模型建议。 */
  model_list_protocols?: readonly ("openai" | "anthropic" | "gemini" | "responses")[];
  /** 官方模型列表接口支持的筛选参数。 */
  model_list_query?: Readonly<Record<string, string>>;
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
    documentation_url: "https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create",
    model_list_protocols: ["openai"],
    suggested_models: ["gpt-6-luna", "gpt-6.2-sol"],
  },
  {
    id: "google",
    label: "Google Gemini",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    gemini_base_url: "https://generativelanguage.googleapis.com",
    documentation_url: "https://aistudio.google.com/docs/openai",
    model_list_protocols: ["openai", "gemini"],
    suggested_models: ["gemini-4-hydrogen", "gemini-4-argon"],
  },
  {
    id: "anthropic",
    label: "Anthropic（Claude）",
    base_url: "https://api.anthropic.com",
    anthropic_base_url: "https://api.anthropic.com",
    documentation_url: "https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk",
    model_list_protocols: ["anthropic"],
    suggested_models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
  },
  {
    id: "deepseek",
    label: "DeepSeek（深度求索）",
    base_url: "https://api.deepseek.com",
    anthropic_base_url: "https://api.deepseek.com/anthropic",
    suggested_models: ["deepseek-flash", "deepseek-v4-pro"],
  },
  {
    id: "moonshot",
    label: "Moonshot（月之暗面 Kimi）",
    vendor: "月之暗面",
    base_url: "https://api.moonshot.cn",
    anthropic_base_url: "https://api.moonshot.cn/anthropic",
    suggested_models: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"],
  },
  {
    id: "moonshot-global",
    label: "Kimi 开放平台（国际）",
    vendor: "月之暗面",
    base_url: "https://api.moonshot.ai/v1",
    responses_base_url: "https://api.moonshot.ai/v1",
    documentation_url: "https://platform.kimi.ai/docs/api/overview",
    model_list_protocols: ["openai"],
    suggested_models: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"],
  },
  {
    id: "groq",
    label: "Groq",
    base_url: "https://api.groq.com/openai",
    documentation_url: "https://console.groq.com/docs/openai",
    model_list_protocols: ["openai"],
    suggested_models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    base_url: "https://openrouter.ai/api",
    documentation_url: "https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion",
    model_list_protocols: ["openai"],
    suggested_models: ["deepseek/deepseek-v4.1-flash-1017", "anthropic/claude-sonnet-5.5"],
  },
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    vendor: "硅基流动",
    base_url: "https://api.siliconflow.cn",
    suggested_models: ["deepseek-ai/DeepSeek-V4.1-Flash", "Qwen/Qwen3.8-27B"],
  },
  {
    id: "siliconflow-global",
    label: "SiliconFlow（国际）",
    vendor: "硅基流动",
    base_url: "https://api.siliconflow.com/v1",
    documentation_url: "https://docs.siliconflow.com/en/userguide/quickstart",
    model_list_protocols: ["openai"],
    model_list_query: { sub_type: "chat" },
    suggested_models: ["deepseek-ai/DeepSeek-V4-Pro-0813"],
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    vendor: "智谱",
    verified: true,
    documentation_url: "https://docs.bigmodel.cn/cn/guide/start/quick-start",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    anthropic_base_url: "https://open.bigmodel.cn/api/anthropic",
    suggested_models: ["glm-5.3-flash", "glm-5.3"],
  },
  {
    // Coding Plan 专属网关（与通用 API 的 key/额度独立，不互通）：
    // chat 走 /api/coding/paas/v4；responses 真实路径为 /api/v1/responses，
    // 而网关拼 /v1/responses → 这里存到版本段之前（/api），见 proxy.ts responsesUrl。
    id: "zhipu-coding",
    label: "智谱 GLM Coding Plan",
    vendor: "智谱",
    verified: true,
    documentation_url: "https://docs.bigmodel.cn/cn/coding-plan/quick-start",
    base_url: "https://open.bigmodel.cn/api/coding/paas/v4",
    anthropic_base_url: "https://open.bigmodel.cn/api/anthropic",
    responses_base_url: "https://open.bigmodel.cn/api",
    suggested_models: ["glm-5.3", "glm-5.3-flash"],
  },
  {
    id: "zai",
    label: "Z.ai GLM（国际）",
    vendor: "智谱",
    base_url: "https://api.z.ai/api/paas/v4",
    documentation_url: "https://docs.z.ai/guides/overview/quick-start",
    model_list_protocols: [],
    suggested_models: ["glm-5.3", "glm-5.3-flash"],
  },
  {
    id: "volcengine",
    label: "火山方舟（豆包）",
    vendor: "火山引擎",
    verified: true,
    documentation_url: "https://docs.volcengine.com/docs/ark/chat-api?lang=zh",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    suggested_models: ["doubao-seed-2-1-lite-260915", "doubao-seed-2-1-pro-260915"],
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
    documentation_url: "https://console.volcengine.com/ark/region:cn-beijing/docs/agent-plan-personal-get-started",
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
    id: "dashscope-cn",
    label: "阿里云百炼（北京）",
    vendor: "阿里云百炼",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    anthropic_base_url: "https://dashscope.aliyuncs.com/apps/anthropic",
    documentation_url: "https://help.aliyun.com/en/model-studio/base-url",
    model_list_protocols: [],
    suggested_models: ["qwen3.8-flash", "qwen3.8-max"],
  },
  {
    id: "dashscope-sg",
    label: "阿里云百炼（新加坡）",
    vendor: "阿里云百炼",
    base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    anthropic_base_url: "https://dashscope-intl.aliyuncs.com/apps/anthropic",
    documentation_url: "https://help.aliyun.com/en/model-studio/base-url",
    model_list_protocols: [],
    suggested_models: ["qwen3.8-flash", "qwen3.8-max"],
  },
  {
    id: "dashscope-us",
    label: "阿里云百炼（弗吉尼亚）",
    vendor: "阿里云百炼",
    base_url: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
    anthropic_base_url: "https://dashscope-us.aliyuncs.com/apps/anthropic",
    documentation_url: "https://help.aliyun.com/en/model-studio/base-url",
    model_list_protocols: [],
    suggested_models: ["qwen3.8-flash", "qwen3.8-max"],
  },
  {
    id: "tokenhub-cn",
    label: "腾讯云 TokenHub（广州）",
    vendor: "腾讯云",
    base_url: "https://tokenhub.tencentmaas.com/v1",
    anthropic_base_url: "https://tokenhub.tencentmaas.com",
    responses_base_url: "https://tokenhub.tencentmaas.com/v1",
    documentation_url: "https://cloud.tencent.com/document/product/1823/130079",
    model_list_protocols: ["openai"],
    suggested_models: ["hy4", "deepseek-v4.1-flash"],
  },
  {
    id: "tokenhub-sg",
    label: "腾讯云 TokenHub（新加坡）",
    vendor: "腾讯云",
    base_url: "https://tokenhub-intl.tencentmaas.com/v1",
    anthropic_base_url: "https://tokenhub-intl.tencentmaas.com",
    responses_base_url: "https://tokenhub-intl.tencentmaas.com/v1",
    documentation_url: "https://cloud.tencent.com/document/product/1823/130079",
    model_list_protocols: ["openai"],
    suggested_models: ["hy4", "deepseek-v4.1-flash"],
  },
  {
    id: "minimax-cn",
    label: "MiniMax（国内）",
    vendor: "MiniMax",
    base_url: "https://api.minimax.cn/v1",
    documentation_url: "https://platform.minimax.cn/docs/api-reference/text-openai-api",
    model_list_protocols: [],
    suggested_models: ["MiniMax-M3", "MiniMax-M3.1-Flash"],
  },
  {
    id: "minimax-global",
    label: "MiniMax（国际）",
    vendor: "MiniMax",
    base_url: "https://api.minimax.io/v1",
    documentation_url: "https://platform.minimax.io/docs/api-reference/text-openai-api",
    model_list_protocols: [],
    suggested_models: ["MiniMax-M3", "MiniMax-M3.1-Flash"],
  },
  {
    id: "qianfan",
    label: "百度智能云千帆",
    base_url: "https://qianfan.baidubce.com/v2",
    responses_base_url: "https://qianfan.baidubce.com/v2",
    documentation_url: "https://cloud.baidu.com/doc/qianfan-api/s/wmwbl48n4",
    model_list_protocols: ["openai"],
    suggested_models: ["qwen3-14b"],
  },
  {
    id: "together",
    label: "Together AI",
    base_url: "https://api.together.ai/v1",
    responses_base_url: "https://api.together.ai/v1",
    documentation_url: "https://docs.together.ai/docs/inference/openai-compatibility",
    model_list_protocols: ["openai"],
    suggested_models: ["MiniMaxAI/MiniMax-M3.1-Flash"],
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    base_url: "https://api.fireworks.ai/inference/v1",
    anthropic_base_url: "https://api.fireworks.ai/inference",
    documentation_url: "https://docs.fireworks.ai/getting-started/quickstart",
    model_list_protocols: [],
    suggested_models: ["accounts/fireworks/models/glm-5p3-flash"],
  },
  {
    id: "xai",
    label: "xAI（Grok）",
    base_url: "https://api.x.ai",
    responses_base_url: "https://api.x.ai",
    documentation_url: "https://docs.x.ai/developers/model-capabilities/text/comparison",
    model_list_protocols: ["openai"],
    suggested_models: ["grok-4.3", "grok-4.7"],
  },
  {
    id: "mistral",
    label: "Mistral",
    base_url: "https://api.mistral.ai",
    documentation_url: "https://docs.mistral.ai/api/endpoint/chat",
    model_list_protocols: ["openai"],
    suggested_models: ["mistral-large-4-0", "ministral-8b-2512"],
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
    suggested_models: ["qwen3.5:4b", "qwen3.5:9b", "gemma4:e4b"],
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

/** 已实测以及可以根据官方调用规范开始联调的预设。 */
const AVAILABLE_PRESET_PROVIDERS: readonly PresetProvider[] =
  PRESET_PROVIDERS.filter((p) => p.verified || p.documentation_url);

/**
 * 编辑时额外列出当前供应商
 * 已有类型，使存量供应商继续可编辑。
 */
export function selectablePresets(currentType?: string): readonly PresetProvider[] {
  if (!currentType) return AVAILABLE_PRESET_PROVIDERS;
  const current = findPresetProvider(currentType);
  if (!current || AVAILABLE_PRESET_PROVIDERS.includes(current)) return AVAILABLE_PRESET_PROVIDERS;
  return PRESET_PROVIDERS.filter((preset) => preset === current || AVAILABLE_PRESET_PROVIDERS.includes(preset));
}
