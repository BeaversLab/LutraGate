import { describe, expect, it } from "vitest";
import { InMemoryKeyState } from "./key-state";

const NOW = 1_000_000;

describe("InMemoryKeyState", () => {
  it("counts failures without cooling down below the threshold", () => {
    const state = new InMemoryKeyState(); // threshold 3
    expect(state.recordFailure("k1", NOW)).toBe(false);
    expect(state.recordFailure("k1", NOW)).toBe(false);
    expect(state.cooldowns.get("k1")).toBeUndefined();
  });

  it("triggers a 60s cooldown when failure_count reaches the threshold", () => {
    const state = new InMemoryKeyState();
    state.recordFailure("k1", NOW);
    state.recordFailure("k1", NOW);
    expect(state.recordFailure("k1", NOW)).toBe(true);
    expect(state.cooldowns.get("k1")).toBe(NOW + 60_000);
  });

  it("restarts the failure window after a cooldown", () => {
    const state = new InMemoryKeyState({ threshold: 2 });
    expect(state.recordFailure("k1", NOW)).toBe(false);
    expect(state.recordFailure("k1", NOW)).toBe(true); // cooldown until NOW+60s
    // After cooldown expiry, the count starts from zero again.
    expect(state.recordFailure("k1", NOW + 60_001)).toBe(false);
    expect(state.recordFailure("k1", NOW + 60_002)).toBe(true);
  });

  it("keeps keys independent", () => {
    const state = new InMemoryKeyState({ threshold: 2 });
    state.recordFailure("k1", NOW);
    expect(state.recordFailure("k2", NOW)).toBe(false);
    expect(state.cooldowns.size).toBe(0);
    state.recordFailure("k2", NOW);
    expect(state.cooldowns.has("k2")).toBe(true);
    expect(state.cooldowns.has("k1")).toBe(false);
  });

  it("notifies via onCooldown when a key enters cooldown (spec §3.2 记日志)", () => {
    const events: Array<[string, number]> = [];
    const state = new InMemoryKeyState({ threshold: 2, onCooldown: (keyId, until) => events.push([keyId, until]) });
    state.recordFailure("k1", NOW);
    expect(events).toHaveLength(0);
    state.recordFailure("k1", NOW);
    expect(events).toEqual([["k1", NOW + 60_000]]);
  });

  it("ignores failures while a cooldown is still active (no extension)", () => {
    const state = new InMemoryKeyState({ threshold: 1, cooldownMs: 60_000 });
    expect(state.recordFailure("k1", NOW)).toBe(true);
    const until = state.cooldowns.get("k1");
    expect(state.recordFailure("k1", NOW + 1_000)).toBe(false);
    expect(state.cooldowns.get("k1")).toBe(until);
  });

  it("honours custom threshold and cooldownMs", () => {
    const state = new InMemoryKeyState({ threshold: 1, cooldownMs: 5_000 });
    expect(state.recordFailure("k1", NOW)).toBe(true);
    expect(state.cooldowns.get("k1")).toBe(NOW + 5_000);
  });
});

// ---- Provider 冷却覆盖（access-control 02）----------------------------------------

describe("InMemoryKeyState: per-call cooldown override (access-control 02)", () => {
  it("override threshold/cooldownMs win for that call; absent fields fall back to instance defaults", () => {
    const state = new InMemoryKeyState(); // 全局默认 3 次 / 60s
    // 只覆盖阈值（1）：首次失败即冷却；冷却时长回退默认 60s。
    expect(state.recordFailure("k1", NOW, { threshold: 1 })).toBe(true);
    expect(state.cooldowns.get("k1")).toBe(NOW + 60_000);
    // 冷却过期后只覆盖时长（5s）：阈值回退默认 3 次。
    expect(state.recordFailure("k1", NOW + 60_001, { cooldownMs: 5_000 })).toBe(false);
    expect(state.recordFailure("k1", NOW + 60_002)).toBe(false);
    expect(state.recordFailure("k1", NOW + 60_003, { cooldownMs: 5_000 })).toBe(true);
    expect(state.cooldowns.get("k1")).toBe(NOW + 60_003 + 5_000);
  });

  it("override applies per key and never mutates instance defaults", () => {
    const state = new InMemoryKeyState();
    expect(state.recordFailure("k1", NOW, { threshold: 1 })).toBe(true);
    // 另一把 key 不受影响：仍是默认阈值 3。
    expect(state.recordFailure("k2", NOW)).toBe(false);
    expect(state.recordFailure("k2", NOW)).toBe(false);
    expect(state.recordFailure("k2", NOW)).toBe(true);
    expect(state.cooldowns.get("k2")).toBe(NOW + 60_000);
  });
});
