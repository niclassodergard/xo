-- Never reuse ids of purged notes, actions and agenda items: a stale reference (e.g. in a chat
-- capture's JSON) must not be able to point at a new, unrelated row. Rebuild the three tables with
-- AUTOINCREMENT (SQLite cannot add it in place), keeping columns, CHECKs, FKs and indexes exactly.
-- Nothing references these tables by foreign key, so DROP TABLE needs no foreign_keys toggle (which
-- is a no-op inside the migration transaction anyway). Existing ids are copied, so sqlite_sequence
-- starts at the current maximum.

CREATE TABLE notes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body_md TEXT NOT NULL DEFAULT '',
  person_id INTEGER REFERENCES people(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
INSERT INTO notes_new (id, title, body_md, person_id, created_at, updated_at, deleted_at)
  SELECT id, title, body_md, person_id, created_at, updated_at, deleted_at FROM notes;
DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;
CREATE INDEX notes_person ON notes(person_id);

CREATE TABLE actions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
  owner TEXT NOT NULL CHECK (owner IN ('me','them')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  person_id INTEGER REFERENCES people(id), meeting_id INTEGER REFERENCES meetings(id),
  created_at TEXT NOT NULL, done_at TEXT, deleted_at TEXT
);
INSERT INTO actions_new (id, text, owner, status, person_id, meeting_id, created_at, done_at, deleted_at)
  SELECT id, text, owner, status, person_id, meeting_id, created_at, done_at, deleted_at FROM actions;
DROP TABLE actions;
ALTER TABLE actions_new RENAME TO actions;
CREATE INDEX actions_open ON actions(status, deleted_at);

CREATE TABLE agenda_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES people(id), text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  created_at TEXT NOT NULL, resolved_at TEXT, resolved_meeting_id INTEGER REFERENCES meetings(id),
  deleted_at TEXT
);
INSERT INTO agenda_items_new (id, person_id, text, status, created_at, resolved_at, resolved_meeting_id, deleted_at)
  SELECT id, person_id, text, status, created_at, resolved_at, resolved_meeting_id, deleted_at FROM agenda_items;
DROP TABLE agenda_items;
ALTER TABLE agenda_items_new RENAME TO agenda_items;
CREATE INDEX agenda_person ON agenda_items(person_id, status);
