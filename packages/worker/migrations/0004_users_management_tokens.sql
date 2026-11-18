-- 多用户（ticket 01）：用户与管理 token。token 只存 SHA-256 哈希，明文仅在
-- 创建/重置响应中出现一次；lgm_ 前缀与数据面访问 key（lgk_，后续迁移）的
-- 哈希集合天然不相交，构成两平面互斥的基础。
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('administrator', 'user')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE management_token (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
ALTER TABLE admin_audit ADD COLUMN actor_user_id TEXT;
