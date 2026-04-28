/**
 * Storage layer — SQLite backed via Node's built-in node:sqlite.
 *
 * Zero native compilation required. Works on any platform with Node 22+.
 * Replaces better-sqlite3 (which requires Visual Studio on Windows).
 *
 * Public API is intentionally identical to the previous JSON/better-sqlite3
 * version so route handlers and the orchestrator need no changes.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, Session } from './types';

const DATA_DIR = process.env.MANUSCOPY_DATA_DIR ?? path.join(process.cwd(), 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const DB_FILE = process.env.MANUSCOPY_SQLITE_PATH ?? path.join(DATA_DIR, 'manuscopy.sqlite');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

type EventRow = { seq: number | bigint; json: string };

declare global {
  // eslint-disable-next-line no-var
  var __manuscopyDb: DatabaseSync | undefined;
}

function db(): DatabaseSync {
  if (globalThis.__manuscopyDb) return globalThis.__manuscopyDb;

  const d = new DatabaseSync(DB_FILE, { enableForeignKeyConstraints: true });
  d.exec('PRAGMA journal_mode = WAL');

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

    CREATE TABLE IF NOT EXISTS reflections (
      sid TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      mode TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      duration_s INTEGER NOT NULL DEFAULT 0,
      tool_count INTEGER NOT NULL DEFAULT 0,
      final_status TEXT NOT NULL DEFAULT 'unknown',
      body TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS learning_backlog (
      sid TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      distilled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_profile (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  globalThis.__manuscopyDb = d;
  migrateJsonData(d);
  return d;
}

/** Minimal transaction helper (node:sqlite has no built-in transaction wrapper). */
function runInTransaction(d: DatabaseSync, fn: () => void): void {
  d.exec('BEGIN');
  try {
    fn();
    d.exec('COMMIT');
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

function migrateJsonData(d: DatabaseSync): void {
  d.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const marker = d.prepare(`SELECT value FROM metadata WHERE key = 'json_migrated'`).get() as
    | { value: string }
    | undefined;
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

  runInTransaction(d, () => {
    if (existsSync(SESSIONS_FILE)) {
      try {
        const sessions = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as Record<
          string,
          Session
        >;
        for (const s of Object.values(sessions)) {
          insertSession.run(s as unknown as Record<string, string | number>);
        }
      } catch (err) {
        console.warn('[manuscopy] sessions.json migration skipped:', err);
      }
    }

    let eventFiles: string[] = [];
    try {
      eventFiles = readdirSync(DATA_DIR).filter(f => /^events_.+\.jsonl$/.test(f));
    } catch { /* ignore */ }

    for (const f of eventFiles) {
      const sessionId = f.slice('events_'.length, -'.jsonl'.length);
      try {
        const lines = readFileSync(path.join(DATA_DIR, f), 'utf-8')
          .split('\n')
          .filter(Boolean);
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
          } catch { /* ignore malformed lines */ }
        }
      } catch (err) {
        console.warn(`[manuscopy] ${f} migration skipped:`, err);
      }
    }

    d.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('json_migrated', '1')`).run();
  });
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    title: row.title as string,
    status: row.status as Session['status'],
    taskMode: row.taskMode as Session['taskMode'],
    costedCredits: Number(row.costedCredits),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function rowToEvent(row: EventRow): AgentEvent {
  const ev = JSON.parse(row.json as string) as AgentEvent;
  return { ...ev, payload: { ...(ev.payload ?? {}), seq: Number(row.seq) } };
}

// ---- Sessions -----------------------------------------------------

export function createSession(s: Session): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO sessions
        (id, title, status, taskMode, costedCredits, createdAt, updatedAt)
       VALUES
        (@id, @title, @status, @taskMode, @costedCredits, @createdAt, @updatedAt)`,
    )
    .run(s as unknown as Record<string, string | number>);
}

export function getSession(id: string): Session | null {
  const row = db()
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

export function listSessions(): Session[] {
  return (
    db()
      .prepare(`SELECT * FROM sessions ORDER BY updatedAt DESC LIMIT 50`)
      .all() as Record<string, unknown>[]
  ).map(rowToSession);
}

export function updateSession(id: string, patch: Partial<Session>): void {
  const existing = getSession(id);
  if (!existing) return;
  const next = { ...existing, ...patch, updatedAt: Date.now() };
  db()
    .prepare(
      `UPDATE sessions
       SET title = @title,
           status = @status,
           taskMode = @taskMode,
           costedCredits = @costedCredits,
           createdAt = @createdAt,
           updatedAt = @updatedAt
       WHERE id = @id`,
    )
    .run(next as unknown as Record<string, string | number>);
}

// ---- Events -------------------------------------------------------

export function appendEvent(e: AgentEvent): void {
  const d = db();
  d.prepare(
    `INSERT OR IGNORE INTO events (id, sessionId, type, timestamp, json)
     VALUES (@id, @sessionId, @type, @timestamp, @json)`,
  ).run({
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
    .prepare(
      `SELECT seq, json FROM events WHERE sessionId = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    )
    .all(sessionId, afterSeq, limit) as EventRow[];
  return rows.map(rowToEvent);
}

export function listAllEvents(sessionId: string): AgentEvent[] {
  return listEventsAfter(sessionId, 0, 100_000);
}

// ---- Reflections --------------------------------------------------

export type ReflectionRow = {
  sid: string;
  ts: string;
  mode: string;
  title: string;
  duration_s: number;
  tool_count: number;
  final_status: string;
  body: string;
};

export function upsertReflection(r: ReflectionRow): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO reflections
        (sid, ts, mode, title, duration_s, tool_count, final_status, body)
       VALUES
        (@sid, @ts, @mode, @title, @duration_s, @tool_count, @final_status, @body)`,
    )
    .run(r as unknown as Record<string, string | number>);
}

export function getReflection(sid: string): ReflectionRow | null {
  const row = db()
    .prepare(`SELECT * FROM reflections WHERE sid = ?`)
    .get(sid) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    sid: row.sid as string,
    ts: row.ts as string,
    mode: row.mode as string,
    title: row.title as string,
    duration_s: Number(row.duration_s),
    tool_count: Number(row.tool_count),
    final_status: row.final_status as string,
    body: row.body as string,
  };
}

export function listReflections(limit = 100): ReflectionRow[] {
  return (
    db()
      .prepare(`SELECT * FROM reflections ORDER BY ts DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[]
  ).map(row => ({
    sid: row.sid as string,
    ts: row.ts as string,
    mode: row.mode as string,
    title: row.title as string,
    duration_s: Number(row.duration_s),
    tool_count: Number(row.tool_count),
    final_status: row.final_status as string,
    body: row.body as string,
  }));
}

// ---- Learning Backlog ---------------------------------------------

export type BacklogStatus = 'pending' | 'distilled' | 'rejected';

export function upsertBacklogItem(
  sid: string,
  status: BacklogStatus,
  distilledAt?: string,
): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO learning_backlog (sid, status, distilled_at)
       VALUES (@sid, @status, @distilled_at)`,
    )
    .run({ sid, status, distilled_at: distilledAt ?? null });
}

export function getBacklogItem(
  sid: string,
): { sid: string; status: BacklogStatus; distilled_at: string | null } | null {
  const row = db()
    .prepare(`SELECT * FROM learning_backlog WHERE sid = ?`)
    .get(sid) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    sid: row.sid as string,
    status: row.status as BacklogStatus,
    distilled_at: (row.distilled_at as string | null) ?? null,
  };
}

export function listBacklogByStatus(status: BacklogStatus): string[] {
  return (
    db()
      .prepare(`SELECT sid FROM learning_backlog WHERE status = ?`)
      .all(status) as { sid: string }[]
  ).map(r => r.sid);
}

// ---- User Profile -------------------------------------------------

/** Retrieve the raw stored profile as a plain object. Returns null if not set. */
export function getStoredProfile(): Record<string, unknown> | null {
  const row = db()
    .prepare(`SELECT value FROM user_profile WHERE key = 'main'`)
    .get() as { value: string } | undefined;
  if (!row) return null;
  try {
    const obj = JSON.parse(row.value);
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Persist a profile object to SQLite. */
export function storeProfile(profile: Record<string, unknown>): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO user_profile (key, value) VALUES ('main', @value)`,
    )
    .run({ value: JSON.stringify(profile) });
}
