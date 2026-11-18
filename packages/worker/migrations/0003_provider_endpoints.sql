-- 供应商端点表：一个供应商可按协议配置多个上游端点（openai / anthropic，
-- 未来可扩展 gemini 等，只加数据不加结构）。搬迁 provider.base_url 为
-- openai 端点后删除原列。
CREATE TABLE provider_endpoint (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  UNIQUE(provider_id, protocol)
);
INSERT INTO provider_endpoint (id, provider_id, protocol, base_url)
  SELECT 'migrated-' || id, id, 'openai', base_url FROM provider WHERE base_url IS NOT NULL AND base_url != '';
ALTER TABLE provider DROP COLUMN base_url;
