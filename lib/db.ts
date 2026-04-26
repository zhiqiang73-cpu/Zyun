/**
 * Storage layer — JSON file based, zero native deps. Suitable for MVP single-user scale.
 *
 *   data/
 *     sessions.json              ← all sessions (object keyed by id)
 *     events_<sessionId>.jsonl   ← append-only event log per session
 *
 * Trade-off vs SQLite: no concurrent multi-writer safety, but Next.js dev server is
 * single-process and our agent writes events sequentially.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import path from 'node:path';
import type { AgentEvent, Session, SessionStatus } from './types';

const DATA_DIR = process.env.MANUSCOPY_DATA_DIR ?? path.join(process.cwd(), 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// In-memory session cache, hydrated from disk on startup.
let _sessionsCache: Record<string, Session> | null = null;

function loadSessions(): Record<string, Session> {
  if (_sessionsCache) return _sessionsCache;
  try {
    if (existsSync(SESSIONS_FILE)) {
      _sessionsCache = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as Record<string, Session>;
    } else {
      _sessionsCache = {};
    }
  } catch {
    _sessionsCache = {};
  }
  return _sessionsCache;
}

function flushSessions(): void {
  // 防并发覆盖：写盘前先 merge 磁盘最新状态。
  // 场景：多个 server 进程（重启过渡期）或多个并发写都可能丢条目。
  // 策略：读盘 → 合并（本进程 cache 优先）→ 全量写。
  let onDisk: Record<string, Session> = {};
  try {
    if (existsSync(SESSIONS_FILE)) {
      onDisk = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    }
  } catch {}
  const merged: Record<string, Session> = { ...onDisk, ...(_sessionsCache ?? {}) };
  _sessionsCache = merged;
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (err) {
    console.error('[manuscopy] failed to flush sessions', err);
  }
}

function eventsFile(sessionId: string): string {
  return path.join(DATA_DIR, `events_${sessionId}.jsonl`);
}

// ---- Sessions -----------------------------------------------------

export function createSession(s: Session): void {
  const all = loadSessions();
  all[s.id] = s;
  flushSessions();
}

export function getSession(id: string): Session | null {
  const all = loadSessions();
  if (all[id]) return all[id];

  // 自动恢复：如果 sessions.json 里没有但 events 文件存在（孤儿 session），
  // 从事件流推断最简元数据，避免 follow-up 因 metadata 丢失而失败。
  // 起因：早期版本多次重启 server 时进程并发写盘可能丢条目。
  const evFile = eventsFile(id);
  if (existsSync(evFile)) {
    try {
      const lines = readFileSync(evFile, 'utf-8').split('\n').filter(l => l.trim());
      if (lines.length === 0) return null;
      let createdAt = Date.now();
      let updatedAt = 0;
      let inferredTitle = '(已恢复)';
      let lastStatus: SessionStatus = 'done';
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (typeof e.timestamp === 'number') {
            if (e.timestamp < createdAt) createdAt = e.timestamp;
            if (e.timestamp > updatedAt) updatedAt = e.timestamp;
          }
          if (inferredTitle === '(已恢复)' && e.type === 'chat' && e.sender === 'user' && e.content) {
            inferredTitle = String(e.content).slice(0, 60);
          }
          if (e.type === 'statusUpdate' && e.payload?.agentStatus) {
            const s = String(e.payload.agentStatus);
            if (s === 'done' || s === 'error') lastStatus = s as SessionStatus;
          }
        } catch {}
      }
      const recovered: Session = {
        id,
        title: inferredTitle,
        status: lastStatus,
        taskMode: 'lite',
        costedCredits: 0,
        createdAt,
        updatedAt,
      };
      // 写回 sessions.json，避免下次再恢复
      all[id] = recovered;
      flushSessions();
      console.warn(`[manuscopy] auto-recovered orphan session ${id}`);
      return recovered;
    } catch (err) {
      console.error('[manuscopy] auto-recover failed', err);
    }
  }
  return null;
}

export function listSessions(): Session[] {
  const all = loadSessions();
  return Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
}

export function updateSession(id: string, patch: Partial<Session>): void {
  const all = loadSessions();
  const existing = all[id];
  if (!existing) return;
  all[id] = { ...existing, ...patch, updatedAt: Date.now() };
  flushSessions();
}

// ---- Events -------------------------------------------------------

export function appendEvent(e: AgentEvent): void {
  try {
    appendFileSync(eventsFile(e.sessionId), JSON.stringify(e) + '\n', 'utf-8');
  } catch (err) {
    console.error('[manuscopy] failed to append event', err);
    return;
  }
  // Touch session updated_at
  const all = loadSessions();
  if (all[e.sessionId]) {
    all[e.sessionId].updatedAt = Date.now();
    flushSessions();
  }
}

export function listEventsAfter(sessionId: string, afterTs: number, limit = 500): AgentEvent[] {
  const file = eventsFile(sessionId);
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const out: AgentEvent[] = [];
  // Read line by line. Events are timestamp-ordered (we always append in real time).
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as AgentEvent;
      if (e.timestamp > afterTs) {
        out.push(e);
        if (out.length >= limit) break;
      }
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

export function listAllEvents(sessionId: string): AgentEvent[] {
  return listEventsAfter(sessionId, 0, 100000);
}
