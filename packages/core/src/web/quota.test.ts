import { describe, expect, it } from "vitest";
import { dayWindowStart, QuotaLedger, QUOTA_SEED_TTL_MS } from "./quota";
import type { AdminDb } from "./admin-auth";

/** 内存 AdminDb：按播种 SQL 的谓词形状过滤用量行，统计读库次数。 */
class FakeAdminDb implements AdminDb {
  rows: Array<{
    user_id?: string;
    access_key_id?: string;
    key_id?: string;
    ts: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  }> = [];
  reads = 0;
  /** 下一次 all() 抛错（模拟播种失败 → fail-open）。 */
  failNext = false;

  async all<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("seed query failed");
    }
    this.reads++;
    const since = params[params.length - 1] as number;
    const inWindow = this.rows.filter((r) => r.ts >= since);
    let matched = inWindow;
    if (sql.includes("access_key_id")) {
      matched = inWindow.filter((r) => r.access_key_id === params[0]);
    } else if (sql.includes("user_id")) {
      matched = inWindow.filter((r) => r.user_id === params[0] && r.key_id === params[1]);
    } else if (sql.includes("key_id")) {
      matched = inWindow.filter((r) => r.key_id === params[0]);
    }
    const tokens = matched.reduce(
      (sum, r) => sum + (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0), 0,
    );
    return [{ requests: matched.length, tokens }] as T[];
  }

  async run(): Promise<{ changes: number }> {
    return { changes: 0 };
  }
}

const T0 = new Date("2026-11-09T12:00:00").getTime();
const DAY = 86_400_000;

const AK: { kind: "access_key"; id: string } = { kind: "access_key", id: "ak-1" };
const GRANT = { kind: "user_grant" as const, user_id: "u-1", provider_key_id: "pk-1" };
const PK: { kind: "provider_key"; id: string } = { kind: "provider_key", id: "pk-1" };

function ledger(db: FakeAdminDb, now: () => number, ttlMs = QUOTA_SEED_TTL_MS) {
  return new QuotaLedger({ db, clock: { now }, ttlMs });
}

describe("dayWindowStart", () => {
  it("snaps to the runtime-local midnight of the same day", () => {
    const start = dayWindowStart(T0);
    expect(start).toBeLessThan(T0);
    expect(T0 - start).toBeLessThan(DAY);
    // 同日任意时刻共享同一窗口起点。
    expect(dayWindowStart(start + 1)).toBe(start);
    expect(dayWindowStart(start + DAY - 1)).toBe(start);
    // 次日翻窗。
    expect(dayWindowStart(start + DAY)).toBe(start + DAY);
  });
});

describe("QuotaLedger.check", () => {
  it("seeds missing ledgers from request_log aggregates", async () => {
    const db = new FakeAdminDb();
    db.rows = [
      { access_key_id: "ak-1", ts: T0, prompt_tokens: 10, completion_tokens: 5 },
      { access_key_id: "ak-1", ts: T0, prompt_tokens: 1 }, // 请求失败路径也计数（token 可缺省）
      { access_key_id: "other", ts: T0, prompt_tokens: 99 },
    ];
    const led = ledger(db, () => T0);
    // 请求限额 3：播种得 requests=2 < 3 → 放行。
    await expect(led.check(AK, { daily_token_limit: 0, daily_request_limit: 3 })).resolves.toBeNull();
    expect(db.reads).toBe(1);
    // token 限额 16：播种得 tokens=16 ≥ 16 → 拒，消息注明级别与种类。
    await expect(led.check(AK, { daily_token_limit: 16, daily_request_limit: 0 })).resolves.toBe(
      "access key token quota exceeded",
    );
  });

  it("is a no-op for unlimited subjects (zero reads)", async () => {
    const db = new FakeAdminDb();
    const led = ledger(db, () => T0);
    await expect(led.check(AK, { daily_token_limit: 0, daily_request_limit: 0 })).resolves.toBeNull();
    expect(db.reads).toBe(0);
  });

  it("serves the seeded ledger within the TTL without re-reading", async () => {
    const db = new FakeAdminDb();
    const led = ledger(db, () => T0);
    await led.check(AK, { daily_token_limit: 100, daily_request_limit: 0 });
    expect(db.reads).toBe(1);
    await led.check(AK, { daily_token_limit: 100, daily_request_limit: 0 });
    expect(db.reads).toBe(1); // TTL 内零读库
  });

  it("re-seeds after the TTL and absorbs usage written by other sources", async () => {
    const db = new FakeAdminDb();
    db.rows = [{ access_key_id: "ak-1", ts: T0, prompt_tokens: 4 }];
    let t = T0;
    const led = ledger(db, () => t);
    await expect(led.check(AK, { daily_token_limit: 100, daily_request_limit: 0 })).resolves.toBeNull();
    // 他源（其他 isolate）直接写库 10 tokens；TTL 过期后重播种吸收。
    db.rows.push({ access_key_id: "ak-1", ts: T0 + 1000, prompt_tokens: 10 });
    t += QUOTA_SEED_TTL_MS + 1;
    await expect(led.check(AK, { daily_token_limit: 14, daily_request_limit: 0 })).resolves.toBe(
      "access key token quota exceeded",
    );
    expect(db.reads).toBe(2);
  });

  it("short-circuits rejected subjects with zero DB reads even past the TTL", async () => {
    const db = new FakeAdminDb();
    db.rows = [{ access_key_id: "ak-1", ts: T0 }];
    let t = T0;
    const led = ledger(db, () => t);
    await expect(led.check(AK, { daily_token_limit: 0, daily_request_limit: 1 })).resolves.toBe(
      "access key request quota exceeded",
    );
    expect(db.reads).toBe(1);
    t += QUOTA_SEED_TTL_MS * 10; // 早已超限：不重播种，直接内存拒绝
    await expect(led.check(AK, { daily_token_limit: 0, daily_request_limit: 1 })).resolves.toBe(
      "access key request quota exceeded",
    );
    expect(db.reads).toBe(1);
  });

  it("fails open on seed errors (treats usage as 0) and retries on the next request", async () => {
    const db = new FakeAdminDb();
    db.rows = [{ access_key_id: "ak-1", ts: T0, prompt_tokens: 99 }];
    db.failNext = true;
    const led = ledger(db, () => T0);
    // 播种失败：当作 0 放行（99 tokens 的历史被暂时无视）。
    await expect(led.check(AK, { daily_token_limit: 1, daily_request_limit: 0 })).resolves.toBeNull();
    // 未标记已播：下个请求重试播种 → 这次读到 99 → 拒。
    await expect(led.check(AK, { daily_token_limit: 1, daily_request_limit: 0 })).resolves.toBe(
      "access key token quota exceeded",
    );
  });

  it("re-seeds into a fresh window after local midnight", async () => {
    const db = new FakeAdminDb();
    db.rows = [{ access_key_id: "ak-1", ts: T0 }];
    let t = T0;
    const led = ledger(db, () => t);
    await expect(led.check(AK, { daily_token_limit: 0, daily_request_limit: 1 })).resolves.toBe(
      "access key request quota exceeded",
    );
    // 跨过本地午夜：新窗口键 → 重新播种；旧行 ts < 窗口起点不计入。
    t = dayWindowStart(T0) + DAY + 1000;
    db.rows.push({ access_key_id: "ak-1", ts: t }); // 新窗口内的行才计
    await expect(led.check(AK, { daily_token_limit: 0, daily_request_limit: 2 })).resolves.toBeNull();
    await expect(led.check(AK, { daily_token_limit: 0, daily_request_limit: 1 })).resolves.toBe(
      "access key request quota exceeded",
    );
  });

  it("names the level and kind in rejection messages for all three subjects", async () => {
    const db = new FakeAdminDb();
    const led = ledger(db, () => T0);
    led.add(GRANT, { requests: 5 });
    await expect(led.check(GRANT, { daily_token_limit: 0, daily_request_limit: 5 })).resolves.toBe(
      "user grant request quota exceeded",
    );
    led.add(PK, { tokens: 7 });
    await expect(led.check(PK, { daily_token_limit: 7, daily_request_limit: 0 })).resolves.toBe(
      "provider key token quota exceeded",
    );
    expect(db.reads).toBe(0); // 纯内存账即可判断
  });
});

describe("QuotaLedger accounting", () => {
  it("accumulates requests and tokens in memory until the next re-seed", async () => {
    const db = new FakeAdminDb();
    let t = T0;
    const led = ledger(db, () => t);
    // 首次 check 播种（空库 → 0）。
    const limits = { daily_token_limit: 100, daily_request_limit: 2 };
    await expect(led.check(AK, limits)).resolves.toBeNull();
    // 受理即计 1 请求；完成后记 tokens（软墙：单请求可越限）。
    led.add(AK, { requests: 1 });
    await expect(led.check(AK, limits)).resolves.toBeNull();
    led.add(AK, { requests: 1, tokens: 150 });
    // requests 达限 → 拒（token 同步越限也不影响消息优先级：先请求种类）。
    await expect(led.check(AK, limits)).resolves.toBe("access key request quota exceeded");
  });
});

describe("QuotaLedger concurrency slots", () => {
  it("rejects the (max+1)-th concurrent request and reuses the slot after release", () => {
    const db = new FakeAdminDb();
    const led = ledger(db, () => T0);
    expect(led.tryAcquireConcurrency("ak-1", 1)).toBe(true);
    expect(led.tryAcquireConcurrency("ak-1", 1)).toBe(false); // 第二并发被拒
    expect(led.tryAcquireConcurrency("other", 1)).toBe(true); // 其他 key 不受影响
    led.releaseConcurrency("ak-1"); // 完成后释放
    expect(led.tryAcquireConcurrency("ak-1", 1)).toBe(true);
    led.releaseConcurrency("ak-1");
    led.releaseConcurrency("other");
    // 释放到底后计数归零（重复释放不会变负数）。
    led.releaseConcurrency("ak-1");
    expect(led.tryAcquireConcurrency("ak-1", 1)).toBe(true);
  });

  it("treats max <= 0 as unlimited", () => {
    const led = ledger(new FakeAdminDb(), () => T0);
    expect(led.tryAcquireConcurrency("ak-1", 0)).toBe(true);
    expect(led.tryAcquireConcurrency("ak-1", 0)).toBe(true);
  });
});
