export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS wechat_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin', 'family')),
  auth_token TEXT NOT NULL,
  uin TEXT NOT NULL,
  base_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  wechat_account_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  display_name TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS polling_state (
  wechat_account_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  wechat_account_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'family')),
  status TEXT NOT NULL DEFAULT 'active',
  summary_text TEXT NOT NULL DEFAULT '',
  memory_json TEXT NOT NULL DEFAULT '{}',
  context_token TEXT NOT NULL DEFAULT '',
  last_active_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  message_type TEXT NOT NULL,
  text_content TEXT,
  file_path TEXT,
  created_at TEXT NOT NULL,
  source_message_id TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  local_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  outbound_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS codex_role_settings (
  role TEXT PRIMARY KEY CHECK(role IN ('admin', 'family')),
  model TEXT,
  reasoning_effort TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS codex_provider_routes (
  route TEXT PRIMARY KEY CHECK(route IN ('admin-acp', 'family-api', 'family-acp')),
  provider_name TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_contacts (
  wechat_account_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (wechat_account_id, contact_id)
);
CREATE TABLE IF NOT EXISTS inbound_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wechat_account_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  contact_id TEXT NOT NULL DEFAULT '',
  is_control INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'needs_review')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(wechat_account_id, source_message_id)
);
CREATE TABLE IF NOT EXISTS job_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action = 'dismiss'),
  actor TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_resolutions_job ON job_resolutions(job_id, id);
CREATE INDEX IF NOT EXISTS inbound_jobs_status ON inbound_jobs(status, id);
CREATE INDEX IF NOT EXISTS sessions_peer ON sessions(wechat_account_id, contact_id, status, updated_at);
CREATE INDEX IF NOT EXISTS messages_session_time ON messages(session_id, created_at);
`;
