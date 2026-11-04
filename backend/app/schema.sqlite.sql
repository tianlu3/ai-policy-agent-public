-- ============================================================
--  AI 政策搜索智能体 · 数据表结构（SQLite 兜底版）
--  ------------------------------------------------------------
--  与 schema.sql（MySQL 8.0+）表结构一一对应，供 DB_ENABLED=sqlite
--  的零依赖模式使用（评审 / 演示环境免装 MySQL）。
--  差异说明：
--    · AUTO_INCREMENT → AUTOINCREMENT；行内不用 ENGINE/CHARSET 等 MySQL 尾缀
--    · DATETIME 存「YYYY-MM-DD HH:MM:SS」文本，默认值用
--      datetime('now','localtime')（与 MySQL 服务器本地时区口径一致）
--    · 唯一键改用列约束（UNIQUE），索引用 CREATE INDEX IF NOT EXISTS
--  由 app/db.py::init() 在服务启动时执行（可重复执行，不破坏已有数据）。
-- ============================================================

-- 用户表：注册写入本表；企业档案字段让用户「填一次就够」
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  email         TEXT    UNIQUE,
  phone         TEXT,
  display_name  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  company       TEXT,
  industry      TEXT,
  region_code   TEXT,
  region_name   TEXT,
  status        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  last_login_at TEXT
);

-- 会话表：登录签发随机 Token，库里只存 SHA-256 摘要
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at   TEXT NOT NULL,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 检索记录表：一次检索一行；result_json 原样保存包装好的十命名空间
CREATE TABLE IF NOT EXISTS search_records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id        TEXT    NOT NULL UNIQUE,
  query          TEXT    NOT NULL,
  regions_json   TEXT    NOT NULL DEFAULT '[]',
  industries     TEXT,
  types          TEXT,
  deadline       TEXT,
  status         TEXT    NOT NULL,
  provider       TEXT,
  degraded       INTEGER NOT NULL DEFAULT 0,
  item_count     INTEGER NOT NULL DEFAULT 0,
  avg_confidence REAL    NOT NULL DEFAULT 0,
  elapsed_ms     INTEGER NOT NULL DEFAULT 0,
  summary        TEXT,
  result_json    TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_records_user_time ON search_records(user_id, id);

-- 政策对话表：政策详情页「问政策」的每一句话
CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_id   TEXT    NOT NULL DEFAULT '',
  policy_name TEXT    DEFAULT '',
  role        TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  provider    TEXT,
  degraded    INTEGER NOT NULL DEFAULT 0,
  elapsed_ms  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_chat_user_policy ON chat_messages(user_id, policy_id, id);
