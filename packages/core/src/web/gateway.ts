import { RequestLogEntrySchema, VERSION, type ConfigGrant, type GatewayConfig, type ProviderKey, type Protocol } from "@lutragate/shared";
import {
  executeWithRetry,
  InMemoryKeyState,
  NoChannelError,
  extractBearer,
  jsonError,
  newId,
  buildUpstreamRequest,
  buildAnthropicRequest,
  buildGeminiRequest,
  buildResponsesRequest,
  forwardBuffered,
  forwardStreamed,
  InvalidBodyError,
  parseChatBody,
  parseMessagesBody,
  parseResponsesBody,
  parseGeminiPath,
  extractUsage,
  injectStreamOptions,
  SseUsageScanner,
  authenticateAccessKey,
  reachableModels,
  restrictToGrants,
  QuotaRejectedError,
  type QuotaLedger,
  type QuotaLimits,
  type AccessIdentity,
} from "../index";
import type { Clock, Fetcher, LogSink, Rng } from "../ports";
import { ipInCidrs } from "../cidr";
import type { KeyState } from "../key-state";
import type { SelectedChannel } from "../select-channel";
import type { Usage } from "./usage";

/**
 * Runtime-agnostic /v1/* gateway handler (spec §1): /health, /v1/models and
 * the two passthrough proxy routes — /v1/chat/completions (OpenAI format)
 * and /v1/messages (Anthropic format). No cross-protocol conversion: a
 * request is served only by providers that configured an endpoint for that
 * protocol; upstream requests are rewritten (model + auth headers) and
 * forwarded verbatim, streaming included. Adapters inject config source,
 * key decryption, log sink and a waitUntil hook.
 */

export const GATEWAY_VERSION = VERSION;
// workerd freezes module-top-level Date.now() (timing side-channel
// mitigation), so the uptime baseline must be recorded lazily on the
// isolate's first request.
let startedAt: number | null = null;

const nativeFetcher: Fetcher = { fetch: (req) => fetch(req) };

// 无账本（v1.0 缺省）时的零分配占位：限额索引不构建。
const EMPTY_GRANT_INDEX = new Map<string, ConfigGrant>();
const EMPTY_KEY_INDEX = new Map<string, ProviderKey>();

/** 错误详情摘要上限（打磨轮 B）：落库截断，防止上游超长报文撑爆日志行。 */
const MAX_ERROR_MESSAGE = 500;

/** 响应体 → 错误详情摘要：自家合成 502 解 error.message；4xx 透传体原样
 * 截断；空体 undefined。上游 4xx body 不重包（spec §3.6），常见 401/429
 * 详情就在其中——排查价值最高的部分。 */
function errorMessageFromBody(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message.length > 0) return truncateErrorMessage(message);
  } catch {
    // 非 JSON body —— 原样截断
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? truncateErrorMessage(trimmed) : undefined;
}

function truncateErrorMessage(text: string): string {
  return text.length <= MAX_ERROR_MESSAGE ? text : `${text.slice(0, MAX_ERROR_MESSAGE)}…`;
}

export interface GatewayDeps {
  /** Active config source (cached store, D1/SQLite/inline). */
  getConfig(): Promise<GatewayConfig>;
  /** Resolves a provider key's plaintext at forward time. */
  resolveKey(key: ProviderKey): Promise<string> | string;
  /** Request-log sink; null disables logging. */
  logSink?: LogSink | null;
  /** Caller-owned cooldown state; defaults to one InMemoryKeyState per handler. */
  keyState?: KeyState;
  /**
   * 配额账本（quota，ADR-0001）：缺省 null = 完全无限额（v1.0 行为）。
   * 适配器按隔离级别各建一个（内存计数 + 惰性播种）。
   */
  quota?: QuotaLedger | null;
  /** Override for tests; defaults to native fetch. */
  fetcher?: Fetcher;
  /**
   * 解析客户端 IP（access-control 02）：adapter 按平台语义提供——worker 取
   * CF-Connecting-IP（平台保证真实性），server 沿用 TRUST_PROXY/XFF 第一跳；
   * 缺省 = 永远未知（设置了白名单即 403）。
   */
  clientIp?: (request: Request) => string | null;
  clock?: Clock;
  rng?: Rng;
}

/** Minimal waitUntil surface (Workers ExecutionContext-like). */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * 访问 key 提取（原网关令牌提取）：OpenAI 客户端 Bearer、Anthropic
 * x-api-key、Gemini x-goog-api-key（或 ?key= 查询参数）携带 lgk_。
 */
export function extractAccessKey(request: Request): string | null {
  return extractAccessKeyCandidates(request)[0] ?? null;
}

/**
 * 全部候选凭证（按提取优先级，去重）：Claude Code 等客户端会**同时**携带
 * 多个凭证头（如 x-api-key 带环境残留的旧 key + Authorization Bearer 带
 * lgk_）——取第一个头就 401 会误伤，逐个候选尝试鉴权（见 handleGateway）。
 */
export function extractAccessKeyCandidates(request: Request): string[] {
  const candidates: string[] = [];
  for (const header of ["x-api-key", "x-goog-api-key"]) {
    const value = request.headers.get(header);
    if (value !== null && value.length > 0) candidates.push(value);
  }
  const queryKey = new URL(request.url).searchParams.get("key");
  if (queryKey !== null && queryKey.length > 0) candidates.push(queryKey);
  const bearer = extractBearer(request);
  if (bearer !== null) candidates.push(bearer);
  return [...new Set(candidates)];
}

interface ProxyBody {
  model: string;
  stream?: boolean;
  [key: string]: unknown;
}

interface ProxyKind {
  protocol: Protocol;
  parseBody(json: unknown): ProxyBody;
  /** 发往上游前的最终请求体（OpenAI 注入 stream_options；Anthropic 原样）。 */
  prepareBody(body: ProxyBody): ProxyBody;
  build(
    channel: SelectedChannel,
    body: ProxyBody,
    clientHeaders: Headers,
    plaintextKey: string,
    /** 客户端查询参数原样透传（Anthropic 用；其余协议忽略）。 */
    search?: string,
  ): Request;
}

const openaiKind: ProxyKind = {
  protocol: "openai",
  parseBody: parseChatBody,
  prepareBody: (body) => injectStreamOptions(body),
  build: buildUpstreamRequest,
};

const anthropicKind: ProxyKind = {
  protocol: "anthropic",
  parseBody: parseMessagesBody,
  prepareBody: (body) => body,
  build: buildAnthropicRequest,
};

const responsesKind: ProxyKind = {
  protocol: "responses",
  parseBody: parseResponsesBody,
  prepareBody: (body) => body,
  build: buildResponsesRequest,
};

export function createGatewayHandler(deps: GatewayDeps) {
  const keyState = deps.keyState ?? new InMemoryKeyState();
  const now = () => (deps.clock ? deps.clock.now() : Date.now());

  return async function handleGateway(request: Request, ctx?: WaitUntilContext): Promise<Response> {
    const url = new URL(request.url);
    startedAt ??= now();

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        version: GATEWAY_VERSION,
        uptime_ms: now() - startedAt,
      });
    }

    // 数据面鉴权（multi-user ticket 04）：配置加载提前到鉴权之前——lgk_ 索引
    // 就在缓存快照里，命中得到 {user_id, access_key_id}，否则 401（lgm_ 管理
    // token 的哈希不在访问 key 索引中，两平面天然互斥）。多凭证头（quota
    // 调试实录：Claude Code 同时带 x-api-key 残留 + Bearer lgk_）逐个候选
    // 尝试，任一命中即通过。
    const candidates = extractAccessKeyCandidates(request);
    if (candidates.length === 0) {
      return jsonError(401, "UNAUTHORIZED", "missing or invalid access key");
    }
    let config: GatewayConfig;
    try {
      config = await deps.getConfig();
    } catch {
      return jsonError(500, "INTERNAL", "failed to load gateway configuration");
    }
    let identity: AccessIdentity | null = null;
    for (const presented of candidates) {
      identity = await authenticateAccessKey(config, presented);
      if (identity !== null) break;
    }
    if (identity === null) {
      return jsonError(401, "UNAUTHORIZED", "missing or invalid access key");
    }

    // ---- 访问控制准入（access-control 02）------------------------------------
    //
    // 快照判定（与 F2.5 缓存、F8.6 跨实例一致，接受 ≤30s 生效延迟）：
    // 先过期（>0 且 now ≥ expires_at → 401），后 IP 白名单（非空且不匹配或
    // IP 未知 → 403 IP_NOT_ALLOWED；与 admin 面 ALLOWED_IPS 语义一致）。
    // 两者都发生在路由之前——拒绝不留痕，不写 request_log（与 quota 429 一致）。
    const accessKeyEntry = config.access_keys.find((k) => k.id === identity.access_key_id);
    if (accessKeyEntry !== undefined) {
      if (accessKeyEntry.expires_at > 0 && now() >= accessKeyEntry.expires_at) {
        return jsonError(401, "UNAUTHORIZED", "access key expired");
      }
      if (accessKeyEntry.ip_allowlist.length > 0) {
        const clientIp = deps.clientIp !== undefined ? deps.clientIp(request) : null;
        if (clientIp === null || !ipInCidrs(clientIp, accessKeyEntry.ip_allowlist)) {
          return jsonError(403, "IP_NOT_ALLOWED", "client IP is not allowed for this access key");
        }
      }
    }

    if (url.pathname === "/v1/models") {
      if (request.method !== "GET") {
        return jsonError(405, "METHOD_NOT_ALLOWED", "only GET is allowed");
      }
      // 授权收敛（PRD F1.2）：仅返回「启用 provider + 启用 mapping + 至少一把
      // 已启用被授权 key」的模型。
      const models = reachableModels(config, identity.user_id);
      return Response.json({
        object: "list",
        data: models.map((id) => ({ id, object: "model", owned_by: "lutragate" })),
      });
    }

    // Gemini 原生格式：模型名在路径里（/v1beta/models/{model}:method）。
    const geminiTarget = parseGeminiPath(url.pathname);
    const kind: ProxyKind | null =
      url.pathname === "/v1/chat/completions" ? openaiKind
      : url.pathname === "/v1/messages" ? anthropicKind
      : url.pathname === "/v1/responses" ? responsesKind
      : null;
    if (kind === null && geminiTarget === null) {
      return jsonError(404, "NOT_FOUND", `no route for ${url.pathname}`);
    }
    // Gemini 请求走专用分支，不经 kind 路径；占位仅为让后续 kind 非空。
    const activeKind = kind ?? openaiKind;
    if (request.method !== "POST") {
      return jsonError(405, "METHOD_NOT_ALLOWED", "only POST is allowed");
    }

    let bodyJson: unknown;
    try {
      bodyJson = await request.json();
    } catch {
      return jsonError(400, "BAD_REQUEST", "request body must be valid JSON");
    }
    let body: ProxyBody;
    if (geminiTarget !== null) {
      // Gemini：model/stream 由 URL 方法段决定，body 原样透传。
      body = {
        ...(typeof bodyJson === "object" && bodyJson !== null ? bodyJson : {}),
        model: geminiTarget.model,
        stream: geminiTarget.method === "streamGenerateContent",
      };
    } else {
      try {
        body = activeKind.parseBody(bodyJson);
      } catch (err) {
        if (err instanceof InvalidBodyError) {
          return jsonError(400, "BAD_REQUEST", err.message);
        }
        throw err;
      }
    }

    // 授权过滤（进入通道选择之前）+ 协议直通过滤：候选上游 key 仅保留该用户
    // 被授权的集合，供应商仅保留配置了该协议端点的。通道选择/重试/冷却逻辑
    // 零改动；无候选自然落 NoChannelError → 503 NO_CHANNEL。
    const granted = restrictToGrants(config, identity.user_id);
    const routable: GatewayConfig = {
      ...granted,
      providers: granted.providers.filter((p) => p.endpoints[geminiTarget !== null ? "gemini" : activeKind.protocol] !== undefined),
    };

    // ---- 准入（quota，ticket 02）：三级限额 + 场景级并发上限 --------------------
    //
    // 无账本或无任何限额主体的请求在此全部短路——账本零调用、零读库、零
    // 额外分配，行为与 v1.0 完全一致。被拒请求直接 429 返回，不写日志
    // （拒绝不留痕，防拒绝风暴变成 DB 写风暴）。
    const quota = deps.quota ?? null;
    const accessKeyQuota = quota === null
      ? null
      : config.access_keys.find((k) => k.id === identity.access_key_id) ?? null;
    const grantsByProviderKey = quota === null
      ? EMPTY_GRANT_INDEX
      : new Map(
          config.grants.filter((g) => g.user_id === identity.user_id).map((g) => [g.provider_key_id, g]),
        );
    const providerKeyById = quota === null ? EMPTY_KEY_INDEX : new Map(config.keys.map((k) => [k.id, k]));
    const nonzero = (l: QuotaLimits) => l.daily_token_limit > 0 || l.daily_request_limit > 0;
    // 快照条目结构上即 QuotaLimits（0 = 不限的字段语义一致）。
    const grantLimitsOf = (providerKeyId: string): QuotaLimits | null => {
      const g = grantsByProviderKey.get(providerKeyId);
      return g && nonzero(g) ? g : null;
    };
    const assetLimitsOf = (providerKeyId: string): QuotaLimits | null => {
      const k = providerKeyById.get(providerKeyId);
      return k && nonzero(k) ? k : null;
    };
    const keyLimits: QuotaLimits | null = accessKeyQuota && nonzero(accessKeyQuota) ? accessKeyQuota : null;
    const maxConcurrency = accessKeyQuota?.max_concurrency ?? 0;
    const quotaActive = quota !== null
      && (keyLimits !== null || maxConcurrency > 0 || routable.keys.some((k) => grantLimitsOf(k.id) ?? assetLimitsOf(k.id)));

    let releaseSlot: (() => void) | null = null;
    if (quota !== null && quotaActive) {
      if (maxConcurrency > 0 && !quota.tryAcquireConcurrency(identity.access_key_id, maxConcurrency)) {
        return jsonError(429, "RATE_LIMITED_LOCAL", "access key concurrency limit exceeded");
      }
      releaseSlot = () => quota.releaseConcurrency(identity.access_key_id);
      if (keyLimits) {
        // 场景级：请求数受理即计（含失败路径）；token 软墙——准入按已累计量
        // 判断，完成后记账（单请求可越限）。
        const rejection = await quota.check({ kind: "access_key", id: identity.access_key_id }, keyLimits);
        if (rejection !== null) {
          releaseSlot();
          return jsonError(429, "RATE_LIMITED_LOCAL", rejection);
        }
        if (keyLimits.daily_request_limit > 0) {
          quota.add({ kind: "access_key", id: identity.access_key_id }, { requests: 1 });
        }
      }
    }
    // 额度只记最终成功渠道的上游 key（授权级/资产级在完成时记账）。
    // channel === null = 无成功渠道（拒绝或整组尝试失败）：授权级/资产级
    // 不记账——failover 中途尝试与全败尝试都不消耗额度；场景级请求数已在
    // 准入时计过。
    const recordQuota = (channel: SelectedChannel | null, usage?: Usage) => {
      if (quota === null || !quotaActive) return;
      const tokens = usage ? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) : 0;
      if (keyLimits?.daily_token_limit && usage) {
        quota.add({ kind: "access_key", id: identity.access_key_id }, { tokens });
      }
      if (channel) {
        const grantLimits = grantLimitsOf(channel.key.id);
        if (grantLimits) {
          quota.add(
            { kind: "user_grant", user_id: identity.user_id, provider_key_id: channel.key.id },
            { requests: 1, ...(usage ? { tokens } : {}) },
          );
        }
        const assetLimits = assetLimitsOf(channel.key.id);
        if (assetLimits) {
          quota.add({ kind: "provider_key", id: channel.key.id }, { requests: 1, ...(usage ? { tokens } : {}) });
        }
      }
    };

    // Request logging (ticket 08): fire-and-forget via LogSink, tracked with
    // the waitUntil hook when available. Failures never affect the proxy path.
    const sink = deps.logSink ?? null;
    const requestId = newId();
    const requestStartedAt = now();
    const log = (fields: {
      status: number;
      channel?: SelectedChannel | null;
      usage?: Usage;
      errorType?: string;
      errorMessage?: string;
    }) => {
      if (!sink) return;
      const entry = RequestLogEntrySchema.parse({
        id: newId(),
        request_id: requestId,
        ts: now(),
        client_model: body.model,
        upstream_model: fields.channel?.upstream_model,
        provider_id: fields.channel?.provider.id,
        key_id: fields.channel?.key.id,
        // 归属（multi-user ticket 04）：成功与错误路径都写入。
        user_id: identity.user_id,
        access_key_id: identity.access_key_id,
        prompt_tokens: fields.usage?.prompt_tokens,
        cached_tokens: fields.usage?.cached_tokens,
        completion_tokens: fields.usage?.completion_tokens,
        latency_ms: now() - requestStartedAt,
        status: fields.status,
        error_type: fields.errorType,
        error_message: fields.errorMessage,
      });
      try {
        const tracked = sink.write(entry) as unknown as Promise<void> | undefined;
        if (ctx && tracked instanceof Promise) {
          ctx.waitUntil(tracked);
        }
      } catch (err) {
        // Logging must never affect the proxy path (spec §3.1).
        console.warn("request log write failed silently:", err);
      }
    };

    // Gemini 上游 body 原样（model 在 URL）；其余协议按 kind 准备。
    const upstreamBody = geminiTarget !== null ? (bodyJson as ProxyBody) : activeKind.prepareBody(body);
    // Side-channel: the buildRequest seam runs right before each attempt, so
    // after executeWithRetry resolves it holds the last (winning) channel.
    let lastChannel: SelectedChannel | null = null;

    try {
      const upstream = await executeWithRetry({
        config: routable,
        clientModel: body.model,
        buildRequest: async (channel) => {
          lastChannel = channel;
          // 授权级/资产级准入随通道解析（failover 中途尝试不消耗额度，检查
          // 不累加；记账只落在最终成功渠道上）。任一命中即整请求 429。
          if (quotaActive && quota) {
            const grantLimits = grantLimitsOf(channel.key.id);
            if (grantLimits) {
              const rejection = await quota.check(
                { kind: "user_grant", user_id: identity.user_id, provider_key_id: channel.key.id },
                grantLimits,
              );
              if (rejection !== null) throw new QuotaRejectedError(rejection);
            }
            const assetLimits = assetLimitsOf(channel.key.id);
            if (assetLimits) {
              const rejection = await quota.check({ kind: "provider_key", id: channel.key.id }, assetLimits);
              if (rejection !== null) throw new QuotaRejectedError(rejection);
            }
          }
          if (geminiTarget !== null) {
            return buildGeminiRequest(
              channel,
              geminiTarget.method as "generateContent" | "streamGenerateContent",
              upstreamBody,
              request.headers,
              await deps.resolveKey(channel.key),
              url.search,
            );
          }
          return activeKind.build(
            channel,
            upstreamBody,
            request.headers,
            await deps.resolveKey(channel.key),
            url.search,
          );
        },
        fetcher: deps.fetcher ?? nativeFetcher,
        keyState,
        clock: deps.clock,
        rng: deps.rng,
      });

      if (body.stream === true) {
        // Log when the stream fully flushes or aborts; usage comes from the
        // final SSE chunk / message_delta event when the provider sends one.
        // 并发槽与额度记账随流结束/中断/错误一并收尾（finally 语义）。
        const scanner = new SseUsageScanner();
        const finishStream = (aborted: boolean) => {
          const usage = scanner.usage();
          log({
            status: upstream.status,
            channel: lastChannel,
            usage,
            ...(aborted ? { errorType: "STREAM_ABORTED" } : {}),
          });
          recordQuota(lastChannel, usage);
          releaseSlot?.();
        };
        return forwardStreamed(upstream, {
          onData: (text) => scanner.push(text),
          onFlush: () => finishStream(false),
          onError: () => finishStream(true),
        });
      }

      const { response, text } = await forwardBuffered(upstream);
      let usage: Usage | undefined;
      try {
        usage = extractUsage(JSON.parse(text));
      } catch {
        // non-JSON body — no usage
      }
      const errorType = upstream.status >= 500 ? "UPSTREAM_ERROR" : undefined;
      // 错误详情（打磨轮 B）：≥400 从响应体提取——≥500 是 executeWithRetry
      // 合成的 502（含各尝试的 last error）；4xx 是上游透传 body。
      const errorMessage = upstream.status >= 400 ? errorMessageFromBody(text) : undefined;
      log({ status: upstream.status, channel: lastChannel, usage, errorType, errorMessage });
      // UPSTREAM_ERROR = executeWithRetry 合成的 502（所有尝试都失败，5xx
      // 真实响应从不透传）→ 无成功渠道，授权级/资产级不记账。
      recordQuota(errorType === "UPSTREAM_ERROR" ? null : lastChannel, usage);
      releaseSlot?.();
      return response;
    } catch (err) {
      releaseSlot?.();
      // 准入被拒（授权级/资产级）：429 且不留痕——不写日志、不记账。
      if (err instanceof QuotaRejectedError) {
        return jsonError(429, "RATE_LIMITED_LOCAL", err.message);
      }
      if (err instanceof NoChannelError) {
        const message =
          err.reason === "NO_MAPPING"
            ? err.message
            : `no ${activeKind.protocol} endpoint for this request (${err.message})`;
        log({ status: 503, channel: null, errorType: `NO_CHANNEL:${err.reason}`, errorMessage: message });
        return jsonError(503, "NO_CHANNEL", message);
      }
      if (err instanceof KeyResolveError) {
        return jsonError(500, "INTERNAL", err.message);
      }
      return jsonError(500, "INTERNAL", "unexpected gateway error");
    }
  };
}

/** Thrown by adapters when a provider key cannot be decrypted/loaded. */
export class KeyResolveError extends Error {}
