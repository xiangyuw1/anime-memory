-- 匹配结果缓存（按归一化后的查询串）
CREATE TABLE IF NOT EXISTS match_cache (
  q TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_match_cache_time ON match_cache (fetched_at);

-- 身份：游客 / 注册用户。游客 id 展示为「游客xxxxx」
CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('guest', 'user')),
  display_name TEXT NOT NULL,
  username_lower TEXT,
  password_hash TEXT,
  password_salt TEXT,
  password_iter INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_identities_display ON identities (display_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identities_username ON identities (username_lower) WHERE username_lower IS NOT NULL;

-- 登录会话：浏览器 cookie 里是 token，库里只存 hash
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_identity ON sessions (identity_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

-- 当前进度（实时写入）
CREATE TABLE IF NOT EXISTS entries (
  identity_id TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  year INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, key)
);

CREATE INDEX IF NOT EXISTS idx_entries_identity ON entries (identity_id, added_at);
CREATE INDEX IF NOT EXISTS idx_entries_key ON entries (key);

-- 历史结果：保存这一轮时的快照
CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  count INTEGER NOT NULL,
  titles TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rounds_identity ON rounds (identity_id, ended_at);
