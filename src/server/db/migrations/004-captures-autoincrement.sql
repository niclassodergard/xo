-- Never reuse capture ids either (same reasoning as 003): a stale client cursor or reference must
-- not be able to point at a new, unrelated capture. SQLite cannot add AUTOINCREMENT in place, so
-- rebuild the table, keeping columns, CHECKs and data exactly. `captures` has no indexes and nothing
-- references it by foreign key. Existing ids are copied, so sqlite_sequence starts at the current maximum.

CREATE TABLE captures_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('text','voice')),
  status TEXT NOT NULL CHECK (status IN ('pending','filed','undone','discarded')),
  draft TEXT NOT NULL,
  question TEXT,
  filed TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  classified_by TEXT CHECK (classified_by IN ('prefix','llm','user')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO captures_new (id, text, source, status, draft, question, filed, summary, classified_by, created_at, updated_at)
  SELECT id, text, source, status, draft, question, filed, summary, classified_by, created_at, updated_at FROM captures;
DROP TABLE captures;
ALTER TABLE captures_new RENAME TO captures;
