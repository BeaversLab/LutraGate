import { describe, expect, it } from "vitest";
import { detectLocale, LOCALE_STORAGE_KEY, localeFromBrowserLanguage } from "./index";
import { en } from "./en";
import { zh } from "./zh";
import { LOG_COLUMNS } from "../lib/logstore.sqlite";

/** 嵌套资源包 → 点路径 key 集合（"app.title" 形式）。 */
function flattenKeys(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [prefix.replace(/\.$/, "")];
  return Object.entries(node).flatMap(([k, v]) => flattenKeys(v, `${prefix}${k}.`));
}

describe("locale detection", () => {
  const storageWith = (entries: Record<string, string>) => ({
    getItem: (key: string) => entries[key] ?? null,
  });

  it("maps browser language zh-* to zh and everything else to en", () => {
    expect(localeFromBrowserLanguage("zh-CN")).toBe("zh");
    expect(localeFromBrowserLanguage("zh")).toBe("zh");
    expect(localeFromBrowserLanguage("en-US")).toBe("en");
    expect(localeFromBrowserLanguage("ja-JP")).toBe("en");
    expect(localeFromBrowserLanguage(undefined)).toBe("en");
  });

  it("a stored valid preference wins over the browser language", () => {
    expect(detectLocale({ language: "zh-CN" }, storageWith({ [LOCALE_STORAGE_KEY]: "en" }))).toBe("en");
    expect(detectLocale({ language: "en-US" }, storageWith({ [LOCALE_STORAGE_KEY]: "zh" }))).toBe("zh");
  });

  it("falls back to the browser language when nothing (valid) is stored", () => {
    expect(detectLocale({ language: "zh-TW" }, storageWith({}))).toBe("zh");
    expect(detectLocale({ language: "en-US" }, storageWith({}))).toBe("en");
    expect(detectLocale({ language: "en-US" }, storageWith({ [LOCALE_STORAGE_KEY]: "fr" }))).toBe("en");
  });
});

describe("zh/en resource packs", () => {
  it("have identical key sets (missing keys must not leak to users)", () => {
    expect(new Set(flattenKeys(en))).toEqual(new Set(flattenKeys(zh)));
  });

  it("ship non-empty values for every key in both packs", () => {
    for (const pack of [zh, en]) {
      for (const key of flattenKeys(pack)) {
        const value = key.split(".").reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], pack);
        expect(typeof value === "string" && value.length > 0, `${pack === zh ? "zh" : "en"}:${key}`).toBe(true);
      }
    }
  });

  it("cover every LOG_COLUMNS field for the dynamic logs.fields.* lookups (#18)", () => {
    // 原始字段页签按列名动态拼 key（t(`logs.fields.${col}`)），静态键集冒烟
    // 看不见——新列漏配会直接把 key 串渲染给用户，这里钉死列 ↔ 键对齐。
    for (const pack of [zh, en]) {
      const fields = (pack as unknown as { logs: { fields: Record<string, string> } }).logs.fields;
      for (const col of LOG_COLUMNS) {
        expect(fields[col], `${pack === zh ? "zh" : "en"}:logs.fields.${col}`).toBeTruthy();
      }
    }
  });

  it("cover every CredentialStatus for the dynamic status.* lookups (#19)", () => {
    // StatusBadge 按枚举动态拼 key（t(`status.${status}`)），新增状态漏配会把
    // key 串渲染给用户——钉死枚举 ↔ 键对齐（同上 #18 手法）。
    const statuses = ["active", "disabled", "expired", "owner_disabled"] as const;
    for (const pack of [zh, en]) {
      const statusPack = (pack as unknown as { status: Record<string, string> }).status;
      for (const s of statuses) {
        expect(statusPack[s], `${pack === zh ? "zh" : "en"}:status.${s}`).toBeTruthy();
      }
    }
  });
});
