import type { Cooldowns } from "./select-channel";

/**
 * Per-key failure counting and cooldown state (spec §3.2).
 *
 * The cooldown table (`cooldowns`) is fed to `selectChannel`, which lazily
 * treats a key as recovered once `cooldown_until < now`; this port lets an
 * adapter swap in a persistent implementation later.
 */

export interface KeyState {
  /** Runtime cooldown table: key_id → cooldown_until (epoch ms). */
  readonly cooldowns: Cooldowns;
  /**
   * Record one failed attempt for a key.
   * Returns true if this failure pushed the key into cooldown.
   */
  recordFailure(keyId: string, now: number, override?: CooldownOverride): boolean;
}

/**
 * Provider 级冷却覆盖（access-control，roadmap v1.2）：字段可选，0/缺省 →
 * 全局默认（threshold 3 次 / cooldownMs 60s）。由 execute-with-retry 在失败
 * 处按 channel 所属 provider 解析注入；KeyState 实例级默认保持不变。
 */
export interface CooldownOverride {
  threshold?: number;
  cooldownMs?: number;
}

export interface KeyStateOptions {
  /** Failures before cooldown; default 3. */
  threshold?: number;
  /** Cooldown duration in ms; default 60s. */
  cooldownMs?: number;
  /** Notified when a key enters cooldown (spec §3.2 "并记日志"). */
  onCooldown?: (keyId: string, cooldownUntil: number) => void;
}

export const FAILURE_THRESHOLD_DEFAULT = 3;
export const COOLDOWN_MS_DEFAULT = 60_000;

/** In-process implementation; adapters may persist across restarts. */
export class InMemoryKeyState implements KeyState {
  readonly cooldowns = new Map<string, number>();
  readonly threshold: number;
  readonly cooldownMs: number;
  private readonly onCooldown?: (keyId: string, cooldownUntil: number) => void;
  private failureCounts = new Map<string, number>();

  constructor(options: KeyStateOptions = {}) {
    this.threshold = options.threshold ?? FAILURE_THRESHOLD_DEFAULT;
    this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS_DEFAULT;
    this.onCooldown = options.onCooldown;
  }

  recordFailure(keyId: string, now: number, override?: CooldownOverride): boolean {
    const until = this.cooldowns.get(keyId);
    if (until !== undefined) {
      if (until >= now) {
        // Already cooling down: further failures cannot extend it.
        return false;
      }
      // Lazy recovery: cooldown expired → start a fresh failure window.
      this.cooldowns.delete(keyId);
      this.failureCounts.delete(keyId);
    }
    // 覆盖值按调用解析（provider 级）；0/缺省字段回落实例默认（全局 3/60s）。
    const threshold = override?.threshold ?? this.threshold;
    const cooldownMs = override?.cooldownMs ?? this.cooldownMs;
    const count = (this.failureCounts.get(keyId) ?? 0) + 1;
    if (count >= threshold) {
      const until = now + cooldownMs;
      this.cooldowns.set(keyId, until);
      this.failureCounts.delete(keyId);
      this.onCooldown?.(keyId, until);
      return true;
    }
    this.failureCounts.set(keyId, count);
    return false;
  }
}
