-- v0.2 question answering: captures gain the statuses 'asked' and 'answered' and two columns,
-- `answer` (the stored answer text) and `sources` (JSON { sent: ref[], cited: ref[] }, ids only).
-- SQLite cannot change a CHECK in place, so rebuild the table (as 004 did), keeping columns, CHECKs and
-- data. `captures` has no indexes and nothing references it by foreign key.
--
-- The AUTOINCREMENT high-water mark must survive the rebuild: copying the rows only restores
-- max(id), but purged captures may have had higher ids, and those ids must never be reused. So the
-- old sqlite_sequence value is copied over before the old table is dropped.

CREATE TABLE captures_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('text','voice')),
  status TEXT NOT NULL CHECK (status IN ('pending','filed','undone','discarded','asked','answered')),
  draft TEXT NOT NULL,
  question TEXT,
  filed TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  classified_by TEXT CHECK (classified_by IN ('prefix','llm','user')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  answer TEXT,
  sources TEXT
);
INSERT INTO captures_new (id, text, source, status, draft, question, filed, summary, classified_by, created_at, updated_at)
  SELECT id, text, source, status, draft, question, filed, summary, classified_by, created_at, updated_at FROM captures;

-- Replace whatever the copy produced (a row only exists if captures_new got rows) by the larger of the
-- old high-water mark and the highest copied id.
DELETE FROM sqlite_sequence WHERE name = 'captures_new';
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'captures_new', MAX(
    COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'captures'), 0),
    COALESCE((SELECT MAX(id) FROM captures), 0))
  WHERE EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'captures') OR EXISTS (SELECT 1 FROM captures);

DROP TABLE captures;
ALTER TABLE captures_new RENAME TO captures;
