import { describe, expect, it } from "vitest";
import type { AccessKeyRow, Identity, UsageRow, UserRow } from "./api";
import {
  alertCount,
  alertTitle,
  availableScopes,
  groupKeyRisks,
  isMenuPanelSurface,
  limitedKeyRisks,
  menuPanelActive,
  MENU_PANEL_SHOWN_EVENT,
  MENU_TICK_EVENT,
  resolveScope,
} from "./menu-bar";

const USER: Identity = { id: "u1", name: "alice", role: "user" };
const ADMIN: Identity = { id: "a1", name: "root", role: "administrator" };
const VIRTUAL_ADMIN: Identity = { id: null, name: null, role: "administrator" };

function userRow(over: Partial<UserRow> = {}): UserRow {
  return {
    id: "u1",
    name: "alice",
    role: "user",
    enabled: true,
    created_at: 1,
    updated_at: 1,
    token_expires_at: 0,
    token_last_used_at: 0,
    token_hint: "",
    ...over,
  };
}

function key(over: Partial<AccessKeyRow> = {}): AccessKeyRow {
  return {
    id: "k1",
    user_id: "u1",
    name: "场景A",
    key_hint: "hint",
    enabled: true,
    daily_token_limit: 0,
    daily_request_limit: 0,
    max_concurrency: 0,
    expires_at: 0,
    ip_allowlist: [],
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

function usage(over: Partial<UsageRow> = {}): UsageRow {
  return {
    access_key_id: "k1",
    requests: 0,
    errors: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    avg_latency_ms: 0,
    ...over,
  };
}

describe("menu bar helpers (menu-bar-usage 03)", () => {
  it("keeps only limited keys and computes per-limit usage lines (tokens = prompt + completion)", () => {
    const rows = limitedKeyRisks(
      [
        key({ id: "a", name: "A", daily_token_limit: 1_000, daily_request_limit: 20 }),
        key({ id: "b", name: "B" }), // no limits → excluded
        key({ id: "c", name: "C", daily_request_limit: 10 }),
      ],
      new Map([
        ["a", usage({ access_key_id: "a", requests: 5, prompt_tokens: 600, completion_tokens: 0 })],
        ["c", usage({ access_key_id: "c", requests: 3 })],
      ]),
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(rows[0]!.tokens).toEqual({ used: 600, limit: 1_000, percent: 60 });
    expect(rows[0]!.requests).toEqual({ used: 5, limit: 20, percent: 25 });
    // Only the configured limit gets a line; the other stays null.
    expect(rows[1]!.tokens).toBeNull();
    expect(rows[1]!.requests).toEqual({ used: 3, limit: 10, percent: 30 });
    expect(rows[0]!.exceeded).toBe(false);
  });

  it("treats the soft-wall overshoot as exceeded and clamps nothing in the percentage", () => {
    const [row] = limitedKeyRisks(
      [key({ id: "a", daily_token_limit: 100 })],
      new Map([["a", usage({ access_key_id: "a", prompt_tokens: 120 })] ]),
    );
    expect(row!.tokens).toEqual({ used: 120, limit: 100, percent: 120 });
    expect(row!.exceeded).toBe(true);
  });

  it("pins exceeded keys, then sorts by highest utilisation, then by name", () => {
    const rows = limitedKeyRisks(
      [
        key({ id: "low", name: "low", daily_token_limit: 100 }),
        key({ id: "hot", name: "hot", daily_token_limit: 100 }),
        key({ id: "over", name: "over", daily_request_limit: 10 }),
        key({ id: "tieA", name: "A", daily_token_limit: 100 }),
        key({ id: "tieB", name: "B", daily_token_limit: 100 }),
      ],
      new Map([
        ["low", usage({ access_key_id: "low", prompt_tokens: 50 })],
        ["hot", usage({ access_key_id: "hot", prompt_tokens: 80 })],
        ["over", usage({ access_key_id: "over", requests: 11 })],
        ["tieA", usage({ access_key_id: "tieA", prompt_tokens: 10 })],
        ["tieB", usage({ access_key_id: "tieB", prompt_tokens: 10 })],
      ]),
    );
    expect(rows.map((r) => r.id)).toEqual(["over", "hot", "low", "tieA", "tieB"]);
  });

  it("resolves available scopes by role and ignores impossible persisted values", () => {
    expect(availableScopes(USER)).toEqual(["self"]);
    expect(availableScopes(ADMIN)).toEqual(["self", "global"]);
    expect(availableScopes(VIRTUAL_ADMIN)).toEqual(["global"]);

    // 普通用户恒为自己；虚拟管理员恒为全局；真实管理员尊重持久化值。
    expect(resolveScope(USER, "global")).toBe("self");
    expect(resolveScope(VIRTUAL_ADMIN, "self")).toBe("global");
    expect(resolveScope(ADMIN, "global")).toBe("global");
    expect(resolveScope(ADMIN, "self")).toBe("self");
    expect(resolveScope(ADMIN, null)).toBe("self");
    expect(resolveScope(ADMIN, "bogus")).toBe("self");
  });

  it("groups risks by user, keeping per-group sort and ordering groups by max utilisation", () => {
    const rows = limitedKeyRisks(
      [
        key({ id: "a1", user_id: "u1", name: "A1", daily_token_limit: 100 }),
        key({ id: "a2", user_id: "u1", name: "A2", daily_token_limit: 100 }),
        key({ id: "b1", user_id: "u2", name: "B1", daily_token_limit: 100 }),
      ],
      new Map([
        ["a1", usage({ access_key_id: "a1", prompt_tokens: 20 })],
        ["a2", usage({ access_key_id: "a2", prompt_tokens: 60 })],
        ["b1", usage({ access_key_id: "b1", prompt_tokens: 90 })],
      ]),
    );
    const groups = groupKeyRisks(rows, [
      userRow({ id: "u1", name: "alice" }),
      userRow({ id: "u2", name: "bob" }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["bob", "alice"]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["b1"]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(["a2", "a1"]);
  });

  it("counts alert keys once per key at >=90% or exceeded and formats the title", () => {
    const rows = limitedKeyRisks(
      [
        key({ id: "calm", name: "calm", daily_token_limit: 100 }),
        key({ id: "warn", name: "warn", daily_token_limit: 100 }),
        key({ id: "danger", name: "danger", daily_token_limit: 100, daily_request_limit: 10 }),
        key({ id: "over", name: "over", daily_request_limit: 10 }),
      ],
      new Map([
        ["calm", usage({ access_key_id: "calm", prompt_tokens: 89 })],
        ["warn", usage({ access_key_id: "warn", prompt_tokens: 90 })],
        // tokens 95% + requests 100%：同一 key 两项超标只计一次。
        ["danger", usage({ access_key_id: "danger", prompt_tokens: 95, requests: 10 })],
        ["over", usage({ access_key_id: "over", requests: 11 })],
      ]),
    );
    expect(alertCount(rows)).toBe(3);
    expect(alertTitle(0)).toBeNull();
    expect(alertTitle(3)).toBe("⚠ 3");
  });

  it("exposes the tick event name alongside the panel-shown event", () => {
    expect(MENU_TICK_EVENT).toBe("lutragate:menu-tick");
  });

  it("makes the menu-panel surface unreachable outside the desktop shell", () => {
    expect(menuPanelActive(false, "#menu-panel")).toBe(false);
    expect(menuPanelActive(true, "#menu-panel")).toBe(true);
    expect(menuPanelActive(true, "")).toBe(false);
  });

  it("detects only the exact menu-panel surface hash and exposes the refresh event name", () => {
    expect(isMenuPanelSurface("#menu-panel")).toBe(true);
    expect(isMenuPanelSurface("#menu-panel/extra")).toBe(false);
    expect(isMenuPanelSurface("")).toBe(false);
    expect(MENU_PANEL_SHOWN_EVENT).toBe("lutragate:panel-shown");
  });
});
