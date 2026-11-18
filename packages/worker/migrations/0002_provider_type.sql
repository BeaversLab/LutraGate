-- 供应商类型（预置目录，参考 new-api 渠道类型）：custom 或 presets.ts 中的 id。
ALTER TABLE provider ADD COLUMN type TEXT NOT NULL DEFAULT 'custom';
