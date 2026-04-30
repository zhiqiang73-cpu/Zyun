import { NextResponse } from 'next/server';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WORKSPACES_DIR =
  process.env.MANUSCOPY_WORKSPACES_DIR ?? path.join(process.cwd(), 'workspaces');

const STATE_FILENAME = '.manuscopy_devserver.json';

type DevServerState = {
  pid?: number;
  port?: number;
  url?: string;
  command?: string;
  log?: string;
  startedAt?: number;
  alive?: boolean;
  reason?: string;
};

async function probePort(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise(resolve => {
    const s = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    try {
      s.connect(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

/**
 * GET /api/tasks/:id/preview
 *
 * Returns the live dev server state for this workspace, if any.
 * The agent starts dev servers via scripts/dev_serve.py which writes
 * `.manuscopy_devserver.json` into workspaces/<id>/.
 *
 * Response shape:
 *   { running: false }                       — no state file
 *   { running: false, reason: 'pid-dead' }   — file exists but server died
 *   { running: true, port, url, command, ... }
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const root = path.join(WORKSPACES_DIR, params.id);
  if (!existsSync(root)) {
    return NextResponse.json({ running: false, reason: 'no-workspace' });
  }

  const statePath = path.join(root, STATE_FILENAME);
  if (!existsSync(statePath)) {
    return NextResponse.json({ running: false, reason: 'no-state' });
  }

  let state: DevServerState;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf-8')) as DevServerState;
  } catch (err) {
    return NextResponse.json({
      running: false,
      reason: 'state-unreadable',
      detail: (err as Error).message,
    });
  }

  if (!state.port) {
    return NextResponse.json({ running: false, reason: 'no-port-in-state', state });
  }

  // Probe whether the port is actually accepting connections (handles "pid still alive
  // but server crashed" and "process killed but stale state file" cases).
  const reachable = await probePort(state.port);
  if (!reachable) {
    return NextResponse.json({
      running: false,
      reason: 'port-not-reachable',
      port: state.port,
      url: state.url,
      command: state.command,
    });
  }

  return NextResponse.json({
    running: true,
    port: state.port,
    url: state.url ?? `http://localhost:${state.port}`,
    command: state.command,
    pid: state.pid,
    startedAt: state.startedAt,
    log: state.log,
  });
}
