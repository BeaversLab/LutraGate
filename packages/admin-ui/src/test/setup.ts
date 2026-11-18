import "fake-indexeddb/auto";
import { beforeEach } from "vitest";
import { i18n } from "../i18n";

// jsdom 未实现 matchMedia：主题三态控件依赖它（UI 2.0 #10），给个可控默认值。
// 需要断言系统亮暗跟随的测试在用例内用 vi.stubGlobal 替换。
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// 组件测试固定 zh（UI 2.0 #10 spec）：断言中文产出（同时验证 key 存在与文案正确）。
// 全局偏好键（lutragate.theme / lutragate.locale）不随环境分槽，用例间清空防串扰。
beforeEach(() => {
  window.localStorage.removeItem("lutragate.theme");
  window.localStorage.removeItem("lutragate.locale");
  document.documentElement.dataset.theme = "";
  void i18n.changeLanguage("zh");
});
