-- Key 管理列表显示最后使用时间（listKeys 子查询 MAX(ts)）：request_log 的
-- key_id 在此之前没有索引，日志量上来后每把 Key 一次全表扫描不可接受。
CREATE INDEX idx_log_key ON request_log(key_id);
