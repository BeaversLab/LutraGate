import type { Fetcher } from "../ports";
import { z } from "zod";
import { signVolcRequest } from "./volc-sign";

/**
 * 供应商套餐窗口配额查询（provider-usage 01/02）：服务端解密凭证后按供应商各自的
 * 管控/监控 API 拉取用量，归一化为统一窗口列表（percentage + reset_at + 可选
 * 绝对值），UI 配额条只认这一种形态——per-provider 的接口与展示差异在各自
 * adapter 的数据映射层消化。只读、不入冷却计数（管理查询不耗 tokens，与
 * model-discovery 同口径）。失败返回 ok:false + 可读原因，UI 灰字呈现不报红。
 *
 * 外部事实（字段结构/可信度分级）：docs/research/provider-usage-apis.md。
 */

/**
 * 管控面凭证（provider-usage 02）：供应商上可选拴带的第二形态凭证，用于查管控面
 * API（用量/账单），与推理 API Key 互不替代。当前唯一形态 = 火山 IAM AK/SK；
 * 服务端整体加密落库（provider.management_credentials），明文不出响应。
 * 放在本模块（而非 admin.ts）避免与 adapter 分发表形成循环依赖。
 */
export const ManagementCredentialsSchema = z.object({
  type: z.literal("volcengine_ak_sk"),
  access_key_id: z.string().min(1),
  secret_access_key: z.string().min(1),
});
export type ManagementCredentials = z.output<typeof ManagementCredentialsSchema>;

export interface UsageWindow {
  /** 稳定窗口键：five_hour / weekly / mcp_monthly（火山档后续扩 daily 等）。 */
  key: string;
  /** 中文窗口名（窗口原名，如「5 小时」「本周」）。 */
  label: string;
  /** 已用百分比 0-100。 */
  percentage: number;
  /** 绝对值标注（如「12.5 / 50 AFP」）；上游未给绝对数时省略（不造数据）。 */
  absolute?: string;
  /** 下次重置时间，epoch ms；上游未给时省略。 */
  reset_at?: number;
}

export interface ProviderUsage {
  /** 套餐等级（上游给什么用什么，可能缺省）。 */
  plan?: string;
  windows: UsageWindow[];
  /** 数据时间，epoch ms（UI 标「N 分钟前」）。 */
  fetched_at: number;
}

export type UsageResult =
  | { ok: true; usage: ProviderUsage }
  | { ok: false; error: string; /** kind=no_credentials → 端点回 400 USAGE_NO_CREDENTIALS（UI 渲染引导态）。 */ kind?: "no_credentials" };

const USAGE_TIMEOUT_MS = 15_000;

/** 防御性数值化：上游字段有漂移史（数字/字符串混用），转不了就放弃该值。 */
function toNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * 智谱 GLM（BigModel / Z.ai）套餐用量：GET {origin}/api/monitor/usage/quota/limit，
 * 鉴权 = 推理用的同一把 API Key，Authorization 裸 token（无 Bearer 前缀，官方插件
 * 逐字用法；实测 Bearer 亦可）。origin 从 provider 端点 base_url 推导（国内
 * open.bigmodel.cn / 国际版 api.z.ai 同路径）。
 *
 * 半公开端点（未入公开文档，官方插件 zai-coding-plugins 在用）→ 字段名有漂移史，
 * 解析必须防御性：缺字段不崩、TOKENS_LIMIT 1~2 个都合法（新套餐 5h+周，老套餐只有
 * 5h）。窗口映射惯例（cc-switch / CodexBar 互相印证）：TOKENS_LIMIT 按 nextResetTime
 * 升序 → 第 1 = 5h、第 2 = 周；TIME_LIMIT = MCP 调用次数月额度（不是 token 月配额，
 * 标注「MCP」防误读）。
 */
export async function fetchZhipuUsage(
  input: { baseUrl: string; apiKey: string },
  fetcher: Fetcher = { fetch: (req) => fetch(req) },
  now: () => number = () => Date.now(),
): Promise<UsageResult> {
  let origin: string;
  try {
    origin = new URL(input.baseUrl).origin;
  } catch {
    return { ok: false, error: "provider endpoint base_url 无法解析" };
  }
  const url = `${origin}/api/monitor/usage/quota/limit`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
  try {
    const resp = await fetcher.fetch(
      new Request(url, {
        method: "GET",
        signal: controller.signal,
        headers: { authorization: input.apiKey },
      }),
    );
    if (!resp.ok) {
      let detail = "";
      try {
        const body = (await resp.json()) as { msg?: string };
        detail = typeof body.msg === "string" ? body.msg : "";
      } catch {
        // 非 JSON 错误体
      }
      return { ok: false, error: `智谱返回 HTTP ${resp.status}${detail ? `：${detail}` : ""}` };
    }
    const body = (await resp.json()) as {
      data?: {
        level?: unknown;
        limits?: Array<{
          type?: unknown;
          percentage?: unknown;
          nextResetTime?: unknown;
        }>;
      };
    };
    const limits = Array.isArray(body.data?.limits) ? body.data!.limits : [];
    const tokenLimits = limits
      .filter((l) => l.type === "TOKENS_LIMIT")
      .map((l) => ({
        percentage: toNumber(l.percentage),
        nextResetTime: toNumber(l.nextResetTime),
      }))
      // 窗口身份靠重置时间排序（5h 窗口先重置）——没有重置时间的条目无法定位窗口，放弃。
      .filter((l): l is { percentage: number | null; nextResetTime: number } => l.nextResetTime !== null)
      .sort((a, b) => a.nextResetTime - b.nextResetTime);
    const windowMeta: Array<{ key: string; label: string }> = [
      { key: "five_hour", label: "5 小时" },
      { key: "weekly", label: "本周" },
    ];
    const windows: UsageWindow[] = [];
    tokenLimits.forEach((l, i) => {
      const meta = windowMeta[i];
      if (!meta || l.percentage === null) return; // 超出两个窗口的条目不认识，跳过
      const w: UsageWindow = { key: meta.key, label: meta.label, percentage: l.percentage };
      w.reset_at = l.nextResetTime;
      windows.push(w);
    });
    // TIME_LIMIT = MCP 调用次数月额度；有就算一条，没有不造。
    for (const l of limits) {
      if (l.type !== "TIME_LIMIT") continue;
      const percentage = toNumber(l.percentage);
      if (percentage === null) continue;
      windows.push({ key: "mcp_monthly", label: "MCP（月）", percentage });
    }
    if (windows.length === 0) {
      return { ok: false, error: "智谱返回了无法识别的用量结构（字段可能已变更）" };
    }
    const plan = typeof body.data?.level === "string" ? body.data.level : undefined;
    return { ok: true, usage: { ...(plan ? { plan } : {}), windows, fetched_at: now() } };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "请求超时（15 秒无响应）" : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** AFP 积分展示格式（"2000.0" → 2000 的去零发生在 toNumber 的 Number 解析层，这里仅转字符串）。 */
function formatAfp(v: number): string {
  return String(v);
}

/** 火山窗口定义（显式命名四窗口；某档位缺窗口则上游不回该字段，自然跳过）。 */
const VOLC_WINDOWS: Array<{ field: string; key: string; label: string }> = [
  { field: "AFPFiveHour", key: "five_hour", label: "5 小时" },
  { field: "AFPDaily", key: "daily", label: "近 1 天" },
  { field: "AFPWeekly", key: "weekly", label: "本周" },
  { field: "AFPMonthly", key: "monthly", label: "本月" },
];

/**
 * 火山方舟 AgentPlan 套餐用量（provider-usage 02）：POST 管控面
 * ?Action=GetAFPUsage&Version=2024-01-01。**管控面域名 ≠ 推理数据面**
 * （ark.cn-beijing.volcengineapi.com，写死在本 adapter，不随 provider 端点走）；
 * 鉴权仅支持 IAM AK/SK Signature V4（来自 provider.management_credentials，
 * 方舟 API Key 无效）。Quota/Used 是字符串（AFP 积分），remaining = Quota − Used；
 * 没有显式 remaining 字段，百分比自行计算。
 */
export async function fetchVolcengineUsage(
  input: { credentials: ManagementCredentials },
  fetcher: Fetcher = { fetch: (req) => fetch(req) },
  now: () => number = () => Date.now(),
): Promise<UsageResult> {
  if (!input.credentials.access_key_id || !input.credentials.secret_access_key) {
    return {
      ok: false,
      error: "尚未配置管控面凭证（IAM AK/SK）；方舟推理 API Key 对管控面无效",
      kind: "no_credentials",
    };
  }
  const host = "ark.cn-beijing.volcengineapi.com";
  const url = `https://${host}/?Action=GetAFPUsage&Version=2024-01-01`;
  const body = "{}";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
  try {
    const signed = await signVolcRequest({
      method: "POST",
      host,
      query: { Action: "GetAFPUsage", Version: "2024-01-01" },
      body,
      accessKeyId: input.credentials.access_key_id,
      secretAccessKey: input.credentials.secret_access_key,
      now: () => new Date(now()),
    });
    const resp = await fetcher.fetch(
      new Request(url, {
        method: "POST",
        signal: controller.signal,
        headers: signed.headers,
        body,
      }),
    );
    if (!resp.ok) {
      let detail = "";
      try {
        const errBody = (await resp.json()) as { ResponseMetadata?: { Error?: { Message?: string } } };
        detail = typeof errBody.ResponseMetadata?.Error?.Message === "string" ? errBody.ResponseMetadata.Error.Message : "";
      } catch {
        // 非 JSON 错误体
      }
      return { ok: false, error: `火山返回 HTTP ${resp.status}${detail ? `：${detail}` : ""}` };
    }
    const usagePayload = (await resp.json()) as {
      Result?: Record<string, unknown> & { PlanType?: unknown };
    };
    const result = usagePayload.Result;
    if (typeof result !== "object" || result === null) {
      return { ok: false, error: "火山返回了无法识别的用量结构（Result 缺失）" };
    }
    const windows: UsageWindow[] = [];
    for (const meta of VOLC_WINDOWS) {
      const raw = result[meta.field] as { Quota?: unknown; Used?: unknown; ResetTime?: unknown } | undefined;
      const quota = toNumber(raw?.Quota);
      const used = toNumber(raw?.Used);
      if (raw === undefined || quota === null || quota <= 0 || used === null) continue; // 档位缺窗口/无效值 → 跳过不造
      const percentage = Math.min(100, Math.max(0, Math.round((used / quota) * 100)));
      const w: UsageWindow = {
        key: meta.key,
        label: meta.label,
        percentage,
        absolute: `${formatAfp(used)} / ${formatAfp(quota)} AFP`,
      };
      const resetAt = toNumber(raw.ResetTime);
      if (resetAt !== null) w.reset_at = resetAt;
      windows.push(w);
    }
    if (windows.length === 0) {
      return { ok: false, error: "火山返回了无法识别的用量结构（无有效窗口；确认账号已订阅 AgentPlan 套餐）" };
    }
    const plan = typeof result.PlanType === "string" ? result.PlanType : undefined;
    return { ok: true, usage: { ...(plan ? { plan } : {}), windows, fetched_at: now() } };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? "请求超时（15 秒无响应）" : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
