-- 多用户（ticket 03）：用户自建访问 key（lgk_，数据面凭证）与上游 provider_key
-- 授权。key 只存 SHA-256 哈希，明文仅在创建响应中出现一次；lgk_ 前缀与管理
-- token（lgm_）的哈希集合天然不相交，两平面互斥。授权挂在用户上：该用户所有
-- 访问 key 只能路由到被授权的上游 key；删除用户或上游 key 时级联清理。
CREATE TABLE access_key (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE user_key_grant (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider_key_id TEXT NOT NULL REFERENCES provider_key(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, provider_key_id)
);
