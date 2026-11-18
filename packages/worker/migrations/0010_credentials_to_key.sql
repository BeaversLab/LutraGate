-- 0010 凭证与用量下沉 key 级（provider-usage 04）：管控面凭证从 provider 行
-- 迁到 provider_key 行——一个供应商可挂多把 key 且可属不同上游账号，配额窗口
-- 是账号维度，key 是账号身份的代理。provider.management_credentials 于 0009
-- 引入，生产库未写入过数据（已核），直接删列无损。
ALTER TABLE provider_key ADD COLUMN management_credentials TEXT;
ALTER TABLE provider DROP COLUMN management_credentials;
