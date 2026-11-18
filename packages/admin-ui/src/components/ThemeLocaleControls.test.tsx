import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThemeLocaleControls } from "./ThemeLocaleControls";
import { i18n } from "../i18n";

type MediaListener = (e: { matches: boolean }) => void;

/** 可控 matchMedia：matches 可变 + change 监听可捕获（驱动 auto 态跟随）。 */
function stubMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<MediaListener>();
  const media = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_: string, l: MediaListener) => listeners.add(l),
    removeEventListener: (_: string, l: MediaListener) => listeners.delete(l),
    addListener: (l: MediaListener) => listeners.add(l),
    removeListener: (l: MediaListener) => listeners.delete(l),
    dispatchEvent: () => false,
    /** 测试驱动：模拟系统亮暗翻转。 */
    setMatches(next: boolean) {
      matches = next;
      for (const l of listeners) l({ matches });
    },
  };
  vi.stubGlobal("matchMedia", () => media);
  return media;
}

afterEach(() => {
  vi.unstubAllGlobals();
  void i18n.changeLanguage("zh");
});

describe("ThemeLocaleControls（#20 图标分段控件）", () => {
  it("defaults to auto and applies the resolved theme", () => {
    stubMatchMedia(false);
    render(<ThemeLocaleControls />);
    expect(screen.getByTestId("theme-auto").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("theme-light").getAttribute("aria-pressed")).toBe("false");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("persists an explicit preference and applies it immediately", () => {
    stubMatchMedia(false);
    render(<ThemeLocaleControls />);
    fireEvent.click(screen.getByTestId("theme-dark"));
    expect(window.localStorage.getItem("lutragate.theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("auto follows system preference changes", () => {
    const media = stubMatchMedia(false);
    render(<ThemeLocaleControls />);
    expect(document.documentElement.dataset.theme).toBe("light");
    media.setMatches(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    media.setMatches(false);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("stops following the system preference once an explicit choice is made", () => {
    const media = stubMatchMedia(false);
    render(<ThemeLocaleControls />);
    fireEvent.click(screen.getByTestId("theme-light"));
    media.setMatches(true);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("switches language, persists it, and re-renders labels", async () => {
    stubMatchMedia(false);
    render(<ThemeLocaleControls />);
    // 语言按钮是语言自称（中/EN），不随翻译变化。
    fireEvent.click(screen.getByTestId("locale-en"));
    expect(window.localStorage.getItem("lutragate.locale")).toBe("en");
    expect(i18n.language).toBe("en");
    // 控件提示文案随语言切换（aria-label 由 t("theme.label") 渲染）。
    expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy();
  });
});
