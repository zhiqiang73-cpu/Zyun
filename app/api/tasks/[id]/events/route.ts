import { NextResponse } from 'next/server';
import { getSession, listEventsAfter } from '@/lib/db';
import type { EventsResponse } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = getSession(params.id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const url = new URL(req.url);
  const afterRaw = url.searchParams.get('after');
  const after = afterRaw ? Number(afterRaw) : 0;
  const events = listEventsAfter(params.id, after, 500);
  const nextAfter = events.length ? events[events.length - 1].timestamp : after;

  const body: EventsResponse = {
    events,
    nextAfter,
    sessionStatus: session.status,
  };
  return NextResponse.json(body, {
    headers: { 'cache-control': 'no-store' },
  });
}
