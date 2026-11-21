import { describe, expect, it } from "vitest";
import { chatCompletionsUrl, modelsListUrl } from "./url";

describe("chatCompletionsUrl", () => {
  it("appends /v1/chat/completions to standard OpenAI-compatible bases", () => {
    expect(chatCompletionsUrl("https://api.openai.com")).toBe("https://api.openai.com/v1/chat/completions");
    expect(chatCompletionsUrl("https://api.deepseek.com/")).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(chatCompletionsUrl("https://api.groq.com/openai")).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  it("reuses a trailing version segment instead of adding /v1", () => {
    // 智谱（含 Coding Plan 端点）与火山方舟的版本化路径
    expect(chatCompletionsUrl("https://open.bigmodel.cn/api/paas/v4")).toBe(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    );
    expect(chatCompletionsUrl("https://open.bigmodel.cn/api/coding/paas/v4/")).toBe(
      "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    );
    expect(chatCompletionsUrl("https://ark.cn-beijing.volces.com/api/v3")).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    );
  });

  it("preserves the documented Gemini OpenAI compatibility path", () => {
    const base = "https://generativelanguage.googleapis.com/v1beta/openai/";
    expect(chatCompletionsUrl(base)).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(modelsListUrl(base)).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
  });

  it("treats non-numeric suffixes as standard bases", () => {
    expect(chatCompletionsUrl("https://x.test/api")).toBe("https://x.test/api/v1/chat/completions");
    expect(chatCompletionsUrl("https://x.test/v1beta")).toBe("https://x.test/v1beta/v1/chat/completions");
  });
});

describe("modelsListUrl", () => {
  it("follows the same version-segment rule as chatCompletionsUrl", () => {
    expect(modelsListUrl("https://api.openai.com")).toBe("https://api.openai.com/v1/models");
    expect(modelsListUrl("https://open.bigmodel.cn/api/coding/paas/v4")).toBe(
      "https://open.bigmodel.cn/api/coding/paas/v4/models",
    );
    expect(modelsListUrl("https://ark.cn-beijing.volces.com/api/v3/")).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/models",
    );
  });
});
