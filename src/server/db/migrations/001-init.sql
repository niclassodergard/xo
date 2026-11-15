CREATE TABLE user (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,          -- scrypt$N$r$p$saltB64$hashB64
  totp_secret TEXT NOT NULL,            -- base32
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,          -- hex sha256 of the cookie token
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE people (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  notes_md TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
);
CREATE TABLE meetings (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id),
  started_at TEXT NOT NULL, ended_at TEXT, notes_md TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX meetings_one_active ON meetings(person_id) WHERE ended_at IS NULL;
CREATE TABLE notes (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, body_md TEXT NOT NULL DEFAULT '',
  person_id INTEGER REFERENCES people(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE actions (
  id INTEGER PRIMARY KEY, text TEXT NOT NULL,
  owner TEXT NOT NULL CHECK (owner IN ('me','them')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  person_id INTEGER REFERENCES people(id), meeting_id INTEGER REFERENCES meetings(id),
  created_at TEXT NOT NULL, done_at TEXT, deleted_at TEXT
);
CREATE TABLE agenda_items (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id), text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  created_at TEXT NOT NULL, resolved_at TEXT, resolved_meeting_id INTEGER REFERENCES meetings(id),
  deleted_at TEXT
);
CREATE TABLE captures (
  id INTEGER PRIMARY KEY, text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('text','voice')),
  status TEXT NOT NULL CHECK (status IN ('pending','filed','undone','discarded')),
  draft TEXT NOT NULL,                  -- JSON CaptureDraft
  question TEXT,                        -- JSON CaptureQuestion or NULL
  filed TEXT NOT NULL DEFAULT '[]',     -- JSON ItemRef[]
  summary TEXT NOT NULL DEFAULT '',
  classified_by TEXT CHECK (classified_by IN ('prefix','llm','user')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX actions_open ON actions(status, deleted_at);
CREATE INDEX agenda_person ON agenda_items(person_id, status);
CREATE INDEX notes_person ON notes(person_id);
