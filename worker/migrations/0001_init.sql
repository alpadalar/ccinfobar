-- ccinfobar marketplace schema; later migrations are additive only

CREATE TABLE counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL) STRICT, WITHOUT ROWID;
INSERT INTO counters (k, n) VALUES ('gen', 0), ('bytes', 0);

CREATE TABLE publishers (
  handle TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 0,
  banned_at TEXT,
  created_at TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;

CREATE TABLE tokens (
  sha256 TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX tokens_by_handle ON tokens (handle);

CREATE TABLE entries (
  publisher TEXT NOT NULL,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preset', 'theme', 'bundle')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'live', 'withdrawn', 'removed')),
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  doc TEXT NOT NULL,
  gen INTEGER NOT NULL,
  PRIMARY KEY (publisher, slug)
) STRICT;
CREATE INDEX entries_by_state ON entries (state, publisher, slug);

CREATE TABLE versions (
  publisher TEXT NOT NULL,
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT,
  PRIMARY KEY (publisher, slug, version)
) STRICT;

CREATE TABLE index_pages (page INTEGER PRIMARY KEY, gen INTEGER NOT NULL, body TEXT NOT NULL) STRICT;

CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  publisher TEXT NOT NULL,
  slug TEXT NOT NULL,
  reporter TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (publisher, slug, reporter)
) STRICT;

CREATE TABLE moderation (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  admin TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
) STRICT;

CREATE TABLE rate (key TEXT PRIMARY KEY, win INTEGER NOT NULL, n INTEGER NOT NULL) STRICT, WITHOUT ROWID;
CREATE TABLE salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL) STRICT, WITHOUT ROWID;
