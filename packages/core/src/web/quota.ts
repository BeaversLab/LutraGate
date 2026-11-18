import type { Clock } from "../ports";
import type { AdminDb } from "./admin-auth";

/**
 * 配额账本（quota，roadmap v1.1 / ADR-0001）：每 isolate 内存计数 + 惰性播种。
 *
 * 键 = (主体, 窗口起始)；条目 = {requests, tokens, seededAt}。主体分三级：
 * 场景级 access_key、授权级 user_grant（用户×上游key）、资产级 provider_key。
 *
 * - 惰性播种：账本缺失或超过 TTL（60s）且恰好有请求进门，才读一次
 *   request_log 当日聚合（索引读）；重播种用库值覆盖内存（ADR-0001——
 *   自己刚完成、异步日志尚未落库的几笔会被低估，方向是松不是紧）。
 * - 超限后内存短路拒绝：账本已超限时后续 check 零读库直接拒。
 * - fail-open：播种失败当作 0 用量放行，不标记已播，下个请求重试。
 * - 0 = 不限：check/add 对无限额主体直接短路（网关也不该调用）。
 * - 并发槽仅场景级：内存计数，acquire/release 由网关在准入/完成时调用。
 * - 日窗口按「窗口起始时间戳」键控：跨本地时区午夜自动失效重播。
 */

/** 主体：三级限额的挂载点。 */
export type QuotaSubject =
  | { kind: "access_key"; id: string }
  | { kind: "user_grant"; user_id: string; provider_key_id: string }
  | { kind: "provider_key"; id: string };

/** 日限额对（并发上限不在账本内——它只有计数槽）。 */
export interface QuotaLimits {
  daily_token_limit: number;
  daily_request_limit: number;
}

/** 播种 TTL（ADR-0001：≤ 每分钟 1 次读库，无流量则为 0）。 */
export const QUOTA_SEED_TTL_MS = 60_000;

/** 自然日窗口起始：运行时本地时区的当日午夜（epoch ms）。 */
export function dayWindowStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface UsageEntry {
  requests: number;
  tokens: number;
  /** 上次播种时刻（epoch ms）；0 = 从未播种（仅内存累加）。 */
  seededAt: number;
}

type ExceedKind = "request" | "token";

const LEVEL_LABELS: Record<QuotaSubject["kind"], string> = {
  access_key: "access key",
  user_grant: "user grant",
  provider_key: "provider key",
};

/** 播种 SQL（D1/SQLite 同构，经 AdminDb 端口）：当日已计请求数与 token 合计。 */
const SEED_AGGREGATE = "COUNT(*) AS requests, COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens";

function seedSql(kind: QuotaSubject["kind"]): string {
  const from = `SELECT ${SEED_AGGREGATE} FROM request_log WHERE `;
  switch (kind) {
    case "access_key":
      return from + "access_key_id = ? AND ts >= ?";
    case "provider_key":
      return from + "key_id = ? AND ts >= ?";
    case "user_grant":
      return from + "user_id = ? AND key_id = ? AND ts >= ?";
  }
}

function subjectKey(subject: QuotaSubject, windowStart: number): string {
  switch (subject.kind) {
    case "access_key":
      return `access_key|${subject.id}|${windowStart}`;
    case "user_grant":
      return `user_grant|${subject.user_id}|${subject.provider_key_id}|${windowStart}`;
    case "provider_key":
      return `provider_key|${subject.id}|${windowStart}`;
  }
}

function exceedKind(entry: UsageEntry, limits: QuotaLimits): ExceedKind | null {
  if (limits.daily_request_limit > 0 && entry.requests >= limits.daily_request_limit) {
    return "request";
  }
  if (limits.daily_token_limit > 0 && entry.tokens >= limits.daily_token_limit) {
    return "token";
  }
  return null;
}

function rejectionMessage(subject: QuotaSubject, kind: ExceedKind): string {
  return `${LEVEL_LABELS[subject.kind]} ${kind} quota exceeded`;
}

export interface QuotaLedgerDeps {
  /** 播种读库端口（D1/SQLite 同构 SQL）。 */
  db: AdminDb;
  /** 可注入时钟（测试：午夜翻窗 / TTL）。 */
  clock?: Clock;
  /** 播种 TTL；默认 60s。 */
  ttlMs?: number;
}

/**
 * 准入被账本拒绝时抛出（buildRequest seam → 网关统一转 429
 * RATE_LIMITED_LOCAL）。消息注明级别与种类，如
 * "user grant token quota exceeded"。
 */
export class QuotaRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaRejectedError";
  }
}

export class QuotaLedger {
  private readonly db: AdminDb;
  private readonly clock?: Clock;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, UsageEntry>();
  /** 场景级并发槽：access_key id → 在途请求数。 */
  private readonly inflight = new Map<string, number>();

  constructor(deps: QuotaLedgerDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.ttlMs = deps.ttlMs ?? QUOTA_SEED_TTL_MS;
  }

  private now(): number {
    return this.clock ? this.clock.now() : Date.now();
  }

  /**
   * 准入检查：超限返回注明级别与种类的 message，否则 null。
   * 账本缺失或超过 TTL 才播种（一次索引读）；已超限则短路零读库；
   * 播种失败 fail-open。0 = 不限的主体直接放行（防呆，网关本不调用）。
   */
  async check(subject: QuotaSubject, limits: QuotaLimits): Promise<string | null> {
    if (limits.daily_request_limit <= 0 && limits.daily_token_limit <= 0) {
      return null;
    }
    const now = this.now();
    const windowStart = dayWindowStart(now);
    const key = subjectKey(subject, windowStart);
    let entry = this.entries.get(key);
    if (entry !== undefined) {
      const hit = exceedKind(entry, limits);
      if (hit !== null) return rejectionMessage(subject, hit); // 超限短路（零读库）
    }
    if (entry === undefined || now - entry.seededAt > this.ttlMs) {
      try {
        const seeded = await this.seed(subject, windowStart);
        entry = { ...seeded, seededAt: now };
        this.entries.set(key, entry);
      } catch {
        // fail-open（ADR-0001）：当作 0 用量放行；不写回账本，下个请求重试。
        entry = entry ?? { requests: 0, tokens: 0, seededAt: 0 };
      }
    }
    const hit = exceedKind(entry, limits);
    return hit === null ? null : rejectionMessage(subject, hit);
  }

  /** 完成后记账（纯内存累加；无账本时建零账，下次 check 会先播种）。 */
  add(subject: QuotaSubject, delta: { requests?: number; tokens?: number }): void {
    if ((delta.requests ?? 0) === 0 && (delta.tokens ?? 0) === 0) return;
    const windowStart = dayWindowStart(this.now());
    const key = subjectKey(subject, windowStart);
    const entry = this.entries.get(key) ?? { requests: 0, tokens: 0, seededAt: 0 };
    entry.requests += delta.requests ?? 0;
    entry.tokens += delta.tokens ?? 0;
    this.entries.set(key, entry);
  }

  /** 取并发槽（仅场景级）：满则 false。max ≤ 0 视为不限，恒 true。 */
  tryAcquireConcurrency(accessKeyId: string, max: number): boolean {
    if (max <= 0) return true;
    const current = this.inflight.get(accessKeyId) ?? 0;
    if (current >= max) return false;
    this.inflight.set(accessKeyId, current + 1);
    return true;
  }

  /** 释放并发槽；响应完成（含流式结束/中断/错误路径）后调用。 */
  releaseConcurrency(accessKeyId: string): void {
    const current = this.inflight.get(accessKeyId) ?? 0;
    if (current <= 1) {
      this.inflight.delete(accessKeyId);
    } else {
      this.inflight.set(accessKeyId, current - 1);
    }
  }

  /** 读 request_log 当日聚合播种一个主体。 */
  private async seed(subject: QuotaSubject, windowStart: number): Promise<{ requests: number; tokens: number }> {
    const params = subject.kind === "user_grant"
      ? [subject.user_id, subject.provider_key_id, windowStart]
      : [subject.id, windowStart];
    const rows = await this.db.all<{ requests: number; tokens: number }>(seedSql(subject.kind), params);
    const row = rows[0];
    return { requests: row?.requests ?? 0, tokens: row?.tokens ?? 0 };
  }
}
