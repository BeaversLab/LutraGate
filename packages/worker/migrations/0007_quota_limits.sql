-- 配额与并发上限（quota 01，roadmap v1.1）：三级限额落表，全部
-- INTEGER NOT NULL DEFAULT 0，0 = 不限。不建新表——账本在内存，播种读
-- request_log 当日聚合（已有所需索引）。
--   场景级：访问 key（lgk_）——用户自设日预算 + 并发上限；
--   授权级：user_key_grant（用户×上游key）——管理员设日预算；
--   资产级：provider_key——管理员设该上游 key 的跨用户日预算总闸。
ALTER TABLE access_key ADD COLUMN daily_token_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE access_key ADD COLUMN daily_request_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE access_key ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_key_grant ADD COLUMN daily_token_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_key_grant ADD COLUMN daily_request_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_key ADD COLUMN daily_token_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_key ADD COLUMN daily_request_limit INTEGER NOT NULL DEFAULT 0;
