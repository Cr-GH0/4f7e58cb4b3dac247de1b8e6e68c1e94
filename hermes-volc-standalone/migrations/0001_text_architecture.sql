-- Mimi text-architecture schema. The voiceprint-era columns are gone: accounts
-- are a 4-digit code (students) or a teacher name, with no enrollment data.
CREATE TABLE IF NOT EXISTS mimi_students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
