-- LutraGate schema (spec §3.3, shared by D1 and SQLite).
CREATE TABLE provider (
  id TEXT PRIMARY KEY,            -- nanoid
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE provider_key (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
  encrypted_key TEXT NOT NULL,    -- base64(iv|ciphertext|tag)
  key_hint TEXT NOT NULL,         -- 末 4 位
  enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_until INTEGER NOT NULL DEFAULT 0,   -- 仅作展示/持久参考，运行态在内存
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE model_mapping (
  id TEXT PRIMARY KEY,
  client_model TEXT NOT NULL,
  provider_id TEXT NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
  upstream_model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(client_model, provider_id)
);
CREATE TABLE request_log (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  client_model TEXT NOT NULL, upstream_model TEXT,
  provider_id TEXT, key_id TEXT,
  prompt_tokens INTEGER, completion_tokens INTEGER,
  latency_ms INTEGER, status INTEGER NOT NULL,
  error_type TEXT
);
CREATE INDEX idx_log_ts ON request_log(ts);
CREATE INDEX idx_log_model ON request_log(client_model);
CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL,
  action TEXT NOT NULL, target TEXT, detail TEXT
);
