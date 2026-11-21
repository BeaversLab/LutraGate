import { describe, expect, it } from "vitest";
import { findPresetProvider } from "@lutragate/shared";
import { runKeyTest } from "./key-test";
import { fetchUpstreamModels } from "./model-list";

describe("documented provider requests", () => {
  it("uses the current OpenAI Chat Completions token limit for the fallback model", async () => {
    const preset = findPresetProvider("openai")!;
    const result = await runKeyTest(
      { baseUrl: preset.base_url, apiKey: "test-key", model: preset.suggested_models[0]! },
      { fetch: async (request) => {
        expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
        expect(await request.json()).toEqual({
          model: "gpt-6-luna", messages: [{ role: "user", content: "ping" }], max_completion_tokens: 64, stream: false,
        });
        return Response.json({ choices: [{ message: { content: "pong" } }] });
      } },
    );
    expect(result).toMatchObject({ ok: true, replyPreview: "pong" });
  });

  it.each([
    ["google", "openai", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
    ["anthropic", "openai", "https://api.anthropic.com/v1/chat/completions"],
    ["anthropic", "anthropic", "https://api.anthropic.com/v1/messages"],
    ["groq", "openai", "https://api.groq.com/openai/v1/chat/completions"],
    ["openrouter", "openai", "https://openrouter.ai/api/v1/chat/completions"],
    ["xai", "openai", "https://api.x.ai/v1/chat/completions"],
    ["xai", "responses", "https://api.x.ai/v1/responses"],
    ["mistral", "openai", "https://api.mistral.ai/v1/chat/completions"],
    ["zai", "openai", "https://api.z.ai/api/paas/v4/chat/completions"],
    ["moonshot-global", "openai", "https://api.moonshot.ai/v1/chat/completions"],
    ["moonshot-global", "responses", "https://api.moonshot.ai/v1/responses"],
    ["siliconflow-global", "openai", "https://api.siliconflow.com/v1/chat/completions"],
    ["dashscope-cn", "openai", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"],
    ["dashscope-sg", "openai", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"],
    ["dashscope-us", "anthropic", "https://dashscope-us.aliyuncs.com/apps/anthropic/v1/messages"],
    ["dashscope-cn", "anthropic", "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages"],
    ["dashscope-sg", "anthropic", "https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/messages"],
    ["dashscope-us", "openai", "https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions"],
    ["tokenhub-cn", "responses", "https://tokenhub.tencentmaas.com/v1/responses"],
    ["tokenhub-sg", "anthropic", "https://tokenhub-intl.tencentmaas.com/v1/messages"],
    ["tokenhub-cn", "openai", "https://tokenhub.tencentmaas.com/v1/chat/completions"],
    ["tokenhub-cn", "anthropic", "https://tokenhub.tencentmaas.com/v1/messages"],
    ["tokenhub-sg", "openai", "https://tokenhub-intl.tencentmaas.com/v1/chat/completions"],
    ["tokenhub-sg", "responses", "https://tokenhub-intl.tencentmaas.com/v1/responses"],
    ["minimax-cn", "openai", "https://api.minimax.cn/v1/chat/completions"],
    ["minimax-global", "openai", "https://api.minimax.io/v1/chat/completions"],
    ["qianfan", "openai", "https://qianfan.baidubce.com/v2/chat/completions"],
    ["qianfan", "responses", "https://qianfan.baidubce.com/v2/responses"],
    ["together", "openai", "https://api.together.ai/v1/chat/completions"],
    ["together", "responses", "https://api.together.ai/v1/responses"],
    ["fireworks", "openai", "https://api.fireworks.ai/inference/v1/chat/completions"],
    ["fireworks", "anthropic", "https://api.fireworks.ai/inference/v1/messages"],
  ] as const)("%s %s sends the documented request to %s", async (id, protocol, expectedUrl) => {
    const preset = findPresetProvider(id)!;
    const base = {
      openai: preset.base_url,
      anthropic: preset.anthropic_base_url,
      responses: preset.responses_base_url,
    }[protocol];
    const model = preset.suggested_models[0] ?? "test-model";
    const result = await runKeyTest(
      { baseUrl: base!, apiKey: "test-key", model, protocol },
      { fetch: async (request) => {
        expect(request.url).toBe(expectedUrl);
        expect(request.method).toBe("POST");
        expect(request.headers.get("content-type")).toBe("application/json");
        if (protocol === "anthropic") {
          expect(request.headers.get("x-api-key")).toBe("test-key");
          expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
          expect(request.headers.get("authorization")).toBeNull();
        } else {
          expect(request.headers.get("authorization")).toBe("Bearer test-key");
        }
        expect(await request.json()).toEqual(protocol === "responses"
          ? { model, input: "Reply with just OK." }
          : { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false });
        const replies = {
          openai: { choices: [{ message: { content: "pong" } }] },
          anthropic: { content: [{ type: "text", text: "pong" }] },
          responses: { output: [{ content: [{ type: "output_text", text: "pong" }] }] },
        };
        return Response.json(replies[protocol]);
      } },
    );
    expect(result).toMatchObject({ ok: true, replyPreview: "pong" });
  });

  it("discovers Qianfan models using the documented v2 route and Bearer key", async () => {
    const result = await fetchUpstreamModels(
      { baseUrl: findPresetProvider("qianfan")!.base_url, apiKey: "test-key", protocol: "openai" },
      { fetch: async (request) => {
        expect(request.url).toBe("https://qianfan.baidubce.com/v2/models");
        expect(request.method).toBe("GET");
        expect(request.headers.get("authorization")).toBe("Bearer test-key");
        return Response.json({ object: "list", data: [{ id: "qwen3-14b" }] });
      } },
    );
    expect(result).toEqual({ ok: true, models: ["qwen3-14b"] });
  });
});
