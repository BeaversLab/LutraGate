-- 访问控制增强（access-control 01，roadmap v1.2）：凭证生命周期、来源网络
-- 与供应商级冷却覆盖，全部可选、不设即维持现状（0/空 = 不启用）。
--   access_key：expires_at（0 = 永不过期，网关按配置快照判定，≤30s 延迟）
--               + ip_allowlist（JSON 字符串数组，IPv4+IPv6 双栈 CIDR，空 = 不限）；
--   management_token：expires_at（0 = 永不过期，admin 鉴权实时查库判定）
--               + last_used_at（每次 lgm_ 成功命中内联更新，无节流）；
--   provider：cooldown_failure_threshold / cooldown_ms（0 = 全局默认 3 次/60s）。
ALTER TABLE access_key ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE access_key ADD COLUMN ip_allowlist TEXT NOT NULL DEFAULT '[]';
ALTER TABLE management_token ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE management_token ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider ADD COLUMN cooldown_failure_threshold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider ADD COLUMN cooldown_ms INTEGER NOT NULL DEFAULT 0;
