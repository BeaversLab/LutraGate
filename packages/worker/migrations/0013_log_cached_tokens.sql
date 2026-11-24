-- 缓存命中列（usage-cached）：usage 缓存命中 token 并入 prompt_tokens 后，
-- 命中量另列记录（Anthropic cache_read_input_tokens / OpenAI
-- prompt_tokens_details.cached_tokens / Gemini cachedContentTokenCount）。
-- 命中量已含在 prompt_tokens 内；历史行与无缓存请求为 NULL。
ALTER TABLE request_log ADD COLUMN cached_tokens INTEGER;
