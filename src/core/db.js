import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDatabase(dbPath) {
  if (!dbPath || typeof dbPath !== 'string') throw new TypeError('dbPath obrigatório.');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    const applicationId = db.prepare('PRAGMA application_id').get().application_id;
    const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
    if (applicationId !== 1313035352 && (applicationId !== 0 || hasTables)) {
      throw new TypeError('dbPath deve apontar para um banco exclusivo do NEXUS Contexto, nunca um banco de outro aplicativo.');
    }
    db.exec(`PRAGMA application_id=1313035352; PRAGMA user_version=1;
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS evidence_blobs (
      project_id TEXT NOT NULL, ref TEXT NOT NULL, content TEXT NOT NULL, format TEXT NOT NULL,
      source_path TEXT, source_sha256 TEXT NOT NULL, source_mtime_ms REAL,
      expires_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL, bytes INTEGER NOT NULL,
      task_id TEXT, PRIMARY KEY(project_id, ref)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memory_entries (
      project_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, content TEXT NOT NULL, rationale TEXT NOT NULL, source_ref TEXT NOT NULL,
      effective_date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','candidate','superseded','revoked')),
      revision INTEGER NOT NULL, supersedes_id TEXT, superseded_by TEXT, event_id TEXT,
      tags TEXT NOT NULL, revoked_reason TEXT, redacted_count INTEGER NOT NULL,
      PRIMARY KEY(project_id,id), UNIQUE(project_id,event_id)
    ) STRICT;
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      project_id UNINDEXED, id UNINDEXED, title, content, rationale, tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_fts(project_id,id,title,content,rationale)
      VALUES(new.project_id,new.id,new.title,new.content,new.rationale); END;
    CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memory_entries BEGIN
      DELETE FROM memory_fts WHERE project_id=old.project_id AND id=old.id; END;
    CREATE TRIGGER IF NOT EXISTS memory_update AFTER UPDATE ON memory_entries BEGIN
      DELETE FROM memory_fts WHERE project_id=old.project_id AND id=old.id;
      INSERT INTO memory_fts(project_id,id,title,content,rationale)
      VALUES(new.project_id,new.id,new.title,new.content,new.rationale); END;
    CREATE TABLE IF NOT EXISTS task_checkpoints (
      project_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
      event_id TEXT, payload TEXT NOT NULL, PRIMARY KEY(project_id,task_id,revision), UNIQUE(project_id,event_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS metrics_events (
      project_id TEXT NOT NULL, operation TEXT NOT NULL, task_id TEXT,
      raw_bytes INTEGER NOT NULL, returned_bytes INTEGER NOT NULL,
      raw_tokens INTEGER NOT NULL, returned_tokens INTEGER NOT NULL,
      latency_ms REAL NOT NULL, reconsult_count INTEGER NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS evidence_lru ON evidence_blobs(project_id,accessed_at);
    CREATE INDEX IF NOT EXISTS metrics_scope ON metrics_events(project_id,task_id);
  `);
  } catch (error) { db.close(); throw error; }
  return db;
}

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
