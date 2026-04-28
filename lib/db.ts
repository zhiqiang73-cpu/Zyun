/**
 * Storage layer — SQLite backed.
 *
 * Public functions intentionally mirror the original JSON/jsonl MVP API so
 * route handlers and the orchestrator can migrate without behavior changes.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, Session } from './types';

const DATA_DIR = process.env.MANUSCOPY_DATA_DIR ?? path.join(process.cwd(), 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const DB_FILE = process.env.MANUSCOPY_SQLITE_PATH ?? path.join(DATA_DIR, 'manuscopy.sqlite');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

type EventRow = {
  seq: number;
  json: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __manuscopyDb: Database.Database | undefined;
}

function db(): Database.Database {
  if (globalThis.__manuscopyDb) return globalThis.__manuscopyDb;

  const d = new Database(DB_FILE);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      taskMode TEXT NOT NULL,
      costedCredits INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      sessionId TEXT NOT NULL,
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(sessionId, seq);
    CREATE INDEX IF NOT EXISTS idx_events_session_timestamp ON events(sessionId, timestamp);
  `);

  globalThis.__manuscopyDb = d;
  migrateJsonData(d);
  return d;
}

function migrateJsonData(d: Database.Database): void {
  // user_version is not returned as a normal row in all bindings; use a simple metadata table instead.
  d.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const marker = d.prepare(`SELECT value FROM metadata WHERE key = 'json_migrated'`).get() as { value?: string } | undefined;
  if (marker?.value === '1') return;

  const insertSession = d.prepare(`
    INSERT OR IGNORE INTO sessions
      (id, title, status, taskMode, costedCredits, createdAt, updatedAt)
    VALUES
      (@id, @title, @status, @taskMode, @costedCredits, @createdAt, @updatedAt)
  `);
  const insertEvent = d.prepare(`
    INSERT OR IGNORE INTO events (id, sessionId, type, timestamp, json)
    VALUES (@id, @sessionId, @type, @timestamp, @json)
  `);

  const migrate = d.transaction(() => {
    if (existsSync(SESSIONS_FILE)) {
      try {
        const sessions = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as Record<string, Session>;
        for (const s of Object.values(sessions)) insertSession.run(s);
      } catch (err) {
        console.warn('[manuscopy] sessions.json migration skipped:', err);
      }
    }

    let eventFiles: string[] = [];
    try {
      eventFiles = readdirSync(DATA_DIR).filter(f => /^events_.+\.jsonl$/.test(f));
    } catch {}

    for (const f of eventFiles) {
      const sessionId = f.slice('events_'.length, -'.jsonl'.length);
      try {
        const lines = readFileSync(path.join(DATA_DIR, f), 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line) as AgentEvent;
            insertEvent.run({
              id: ev.id,
              sessionId: ev.sessionId || sessionId,
              type: ev.type,
              timestamp: ev.timestamp,
              json: JSON.stringify(ev),
            });
          } catch {}
        }
      } catch (err) {
        console.warn(`[manuscopy] ${f} migration skipped:`, err);
      }
    }

    d.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('json_migrated', '1')`).run();
  });

  migrate();
}

function rowToSession(row: any): Session {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    taskMode: row.taskMode,
    costedCredits: row.costedCredits,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToEvent(row: EventRow): AgentEvent {
  const ev = JSON.parse(row.json) as AgentEvent;
  return { ...ev, payload: { ...(ev.payload ?? {}), seq: row.seq } };
}

// ---- Sessions -----------------------------------------------------

export function createSession(s: Session): void {
  db().prepare(`
    INSERT OR REPLACE INTO sessions
      (id, title, status, taskMode, costedCredits, createdAt, updatedAt)
    VALUES
      (@id, @title, @status, @taskMode, @costedCredits, @createdAt, @updatedAt)
  `).run(s);
}

export function getSession(id: string): Session | null {
  const row = db().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
  return row ? rowToSession(row) : null;
}

export function listSessions(): Session[] {
  return db()
    .prepare(`SELECT * FROM sessions ORDER BY updatedAt DESC LIMIT 50`)
    .all()
    .map(rowToSession);
}

export function updateSession(id: string, patch: Partial<Session>): void {
  const existing = getSession(id);
  if (!existing) return;
  const next = { ...existing, ...patch, updatedAt: Date.now() };
  db().prepare(`
    UPDATE sessions
    SET title = @title,
        status = @status,
        taskMode = @taskMode,
        costedCredits = @costedCredits,
        createdAt = @createdAt,
        updatedAt = @updatedAt
    WHERE id = @id
  `).run(next);
}

// ---- Events -------------------------------------------------------

export function appendEvent(e: AgentEvent): void {
  const d = db();
  d.prepare(`
    INSERT OR IGNORE INTO events (id, sessionId, type, timestamp, json)
    VALUES (@id, @sessionId, @type, @timestamp, @json)
  `).run({
    id: e.id,
    sessionId: e.sessionId,
    type: e.type,
    timestamp: e.timestamp,
    json: JSON.stringify(e),
  });
  d.prepare(`UPDATE sessions SET updatedAt = ? WHERE id = ?`).run(Date.now(), e.sessionId);
}

export function listEventsAfter(sessionId: string, afterSeq: number, limit = 500): AgentEvent[] {
  const rows = db()
    .prepare(`SELECT seq, json FROM events WHERE sessionId = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
    .all(sessionId, afterSeq, limit) as EventRow[];
  return rows.map(rowToEvent);
}

export function listAllEvents(sessionId: string): AgentEvent[] {
  return listEventsAfter(sessionId, 0, 100000);
}
