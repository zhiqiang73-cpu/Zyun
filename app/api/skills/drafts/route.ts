import { NextResponse } from 'next/server';
import { listSkillDrafts, countSkillDraftsByStatus, type SkillDraftStatus } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED: SkillDraftStatus[] = ['pending', 'approved', 'rejected'];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status') ?? undefined;
  const status =
    statusParam && ALLOWED.includes(statusParam as SkillDraftStatus)
      ? (statusParam as SkillDraftStatus)
      : undefined;

  const drafts = listSkillDrafts(status);
  const counts = {
    pending: countSkillDraftsByStatus('pending'),
    approved: countSkillDraftsByStatus('approved'),
    rejected: countSkillDraftsByStatus('rejected'),
  };
  return NextResponse.json({ drafts, counts });
}
