import { NextResponse } from 'next/server';
import { runDistillation, MIN_PENDING_FOR_AUTO_DISTILL } from '@/lib/skill-distiller';
import { listBacklogByStatus } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // helper LLM may take ~30-60s

/** GET — show current distill readiness without running it. */
export async function GET() {
  const pending = listBacklogByStatus('pending');
  return NextResponse.json({
    pending_count: pending.length,
    threshold: MIN_PENDING_FOR_AUTO_DISTILL,
    ready: pending.length >= MIN_PENDING_FOR_AUTO_DISTILL,
  });
}

/**
 * POST — run distillation now (manual trigger).
 * Body (optional): { max?: number, force?: boolean }
 *   max: how many pending reflections to process at once (default 12)
 *   force: bypass the MIN_PENDING_FOR_AUTO_DISTILL gate (default false)
 */
export async function POST(req: Request) {
  let body: { max?: number; force?: boolean } = {};
  try {
    body = (await req.json()) as { max?: number; force?: boolean };
  } catch { /* no body is fine */ }

  const pending = listBacklogByStatus('pending');
  if (!body.force && pending.length < MIN_PENDING_FOR_AUTO_DISTILL) {
    return NextResponse.json(
      {
        ok: false,
        reason: `Only ${pending.length} pending reflections (need ≥ ${MIN_PENDING_FOR_AUTO_DISTILL}). Pass {force:true} to run anyway.`,
      },
      { status: 400 },
    );
  }

  const max = typeof body.max === 'number' && body.max > 0 ? Math.min(body.max, 30) : 12;
  const result = await runDistillation(max);
  return NextResponse.json(result);
}
