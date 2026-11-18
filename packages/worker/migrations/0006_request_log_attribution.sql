-- 多用户（ticket 04）：请求日志归属列。每条代理请求日志（含错误路径）写入
-- 发起用户的 user_id 与其所用 access_key_id；历史行保持可空。按用户与按 key
--（=按场景）聚合的用量查询（ticket 05）依赖这两列与对应索引。
ALTER TABLE request_log ADD COLUMN user_id TEXT;
ALTER TABLE request_log ADD COLUMN access_key_id TEXT;
CREATE INDEX idx_log_user ON request_log(user_id);
CREATE INDEX idx_log_access_key ON request_log(access_key_id);
