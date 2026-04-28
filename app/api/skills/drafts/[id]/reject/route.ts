import { NextResponse } from 'next/server';
import { getSkillDraft, updateSkillDraftStatus } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Reject a skill draft → mark rejected with optional reason.
 * Body: { reason?: string }
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const draft = getSkillDraft(params.id);
  if (!draft) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (draft.status !== 'pending') {
    return NextResponse.json(
      { error: `draft already ${draft.status}` },
      { status: 409 },
    );
  }

  let body: { reason?: string } = {};
  try {
    body = (await req.json()) as { reason?: string };
  } catch { /* no body is fine */ }

  const reason = (body.reason ?? '').trim().slice(0, 500) || null;
  updateSkillDraftStatus(draft.id, 'rejected', reason);
  return NextResponse.json({ ok: true, reason });
}
