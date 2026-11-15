-- v0.2: projects, links to people, project_id on actions and notes, sidebar pins and recents.
-- No table rebuilds: new tables plus nullable ADD COLUMNs (SQLite allows REFERENCES with a NULL default).
-- Ids are never reused (AUTOINCREMENT). `pins` and `recents` hold ids only, never titles.

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','done')),
  description_md TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE project_people (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, person_id)
);

ALTER TABLE actions ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE notes ADD COLUMN project_id INTEGER REFERENCES projects(id);
CREATE INDEX actions_project ON actions(project_id);
CREATE INDEX notes_project ON notes(project_id);

CREATE TABLE pins (
  kind TEXT NOT NULL CHECK (kind IN ('person','project')),
  item_id INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (kind, item_id)
);

CREATE TABLE recents (
  kind TEXT NOT NULL CHECK (kind IN ('person','project','meeting','note')),
  item_id INTEGER NOT NULL, opened_at TEXT NOT NULL,
  PRIMARY KEY (kind, item_id)
);
