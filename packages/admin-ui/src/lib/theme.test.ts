import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  loadThemePref,
  resolveTheme,
  saveThemePref,
  type ThemePreference,
} from "./theme";

function storageWith(entries: Record<string, string>): Pick<Storage, "getItem"> {
  return { getItem: (key: string) => entries[key] ?? null };
}

describe("theme preference storage", () => {
  it("defaults to auto when nothing is stored", () => {
    expect(loadThemePref(storageWith({}))).toBe("auto");
  });

  it("round-trips a stored preference", () => {
    for (const pref of ["auto", "light", "dark"] as ThemePreference[]) {
      const store: Record<string, string> = {};
      saveThemePref({ setItem: (k, v) => (store[k] = v) }, pref);
      expect(store[THEME_STORAGE_KEY]).toBe(pref);
      expect(loadThemePref(storageWith(store))).toBe(pref);
    }
  });

  it("falls back to auto on invalid stored values", () => {
    expect(loadThemePref(storageWith({ [THEME_STORAGE_KEY]: "blue" }))).toBe("auto");
    expect(loadThemePref(storageWith({ [THEME_STORAGE_KEY]: "" }))).toBe("auto");
  });
});

describe("resolveTheme", () => {
  it("auto follows the system preference", () => {
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
  });

  it("explicit preferences ignore the system preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
