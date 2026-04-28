import { NextResponse } from 'next/server';
import { getSkillDraft } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const draft = getSkillDraft(params.id);
  if (!draft) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ draft });
}
