import { NextResponse } from 'next/server';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getSession, updateSession } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WORKSPACES_DIR =
  process.env.MANUSCOPY_WORKSPACES_DIR ?? path.join(process.cwd(), 'workspaces');

function stopMarkerPath(id: string): string {
  return path.join(WORKSPACES_DIR, id, '.manuscopy_stop');
}

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const session = getSession(params.id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  if (session.status === 'done' || session.status === 'error' || session.status === 'stopped') {
    return NextResponse.json(
      { error: `session is already ${session.status}` },
      { status: 409 },
    );
  }

  const marker = stopMarkerPath(params.id);
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, JSON.stringify({ requestedAt: Date.now() }), 'utf-8');
  updateSession(params.id, { status: 'stopped' });

  return NextResponse.json({ ok: true });
}
