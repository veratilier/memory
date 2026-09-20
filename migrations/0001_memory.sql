-- Private data belongs only in D1; migrations contain schema, never records.
CREATE TABLE users (
 id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, auth_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 auth_version INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE login_attempts (ip_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_start INTEGER NOT NULL);
CREATE TABLE service_tokens (
 id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL, scopes TEXT NOT NULL, auth_version INTEGER NOT NULL,
 created_at TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE memories (
 id TEXT PRIMARY KEY, source_id TEXT UNIQUE NOT NULL, body TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('episode','preference','agreement','reflection','dream')),
 source TEXT NOT NULL, source_url TEXT, occurred_at TEXT, recorded_at TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 supersedes TEXT UNIQUE REFERENCES memories(id), root_id TEXT NOT NULL,
 version INTEGER NOT NULL, correction_reason TEXT,
 CHECK((supersedes IS NULL AND version=1) OR (supersedes IS NOT NULL AND version>1))
);
CREATE INDEX memories_active ON memories(active,recorded_at DESC);
CREATE INDEX memories_root ON memories(root_id,version);
CREATE TRIGGER valid_correction BEFORE INSERT ON memories WHEN NEW.supersedes IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'stale_version') WHERE NOT EXISTS (
  SELECT 1 FROM memories WHERE id=NEW.supersedes AND active=1 AND root_id=NEW.root_id AND version=NEW.version-1
 );
END;
CREATE TRIGGER supersede_previous AFTER INSERT ON memories WHEN NEW.supersedes IS NOT NULL
BEGIN UPDATE memories SET active=0 WHERE id=NEW.supersedes; END;
CREATE TABLE memory_terms (memory_id TEXT NOT NULL REFERENCES memories(id), term TEXT NOT NULL, PRIMARY KEY(memory_id,term));
CREATE INDEX memory_terms_lookup ON memory_terms(term,memory_id);
CREATE TABLE embeddings (memory_id TEXT NOT NULL REFERENCES memories(id), model TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(memory_id,model));
