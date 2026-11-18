-- 0009 管控面凭证（provider-usage 02）：供应商上可选拴带的第二形态凭证，
-- 用于查管控面 API（用量/账单），与推理 API Key 互不替代。AES-GCM 加密
-- JSON（{"type":"volcengine_ak_sk",...}）落库，可空 = 未启用管控面查询。
ALTER TABLE provider ADD COLUMN management_credentials TEXT;
