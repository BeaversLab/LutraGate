-- 日志错误详情（打磨轮 B）：上游失败时截断落一条错误摘要（≤500 字符），
-- 原始日志面板失败行展开显示。历史行与成功路径为 NULL。
ALTER TABLE request_log ADD COLUMN error_message TEXT;
