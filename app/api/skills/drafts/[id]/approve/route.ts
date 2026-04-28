import { NextResponse } from 'next/server';
import path from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { getSkillDraft, updateSkillDraftStatus } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROJECT_ROOT = process.cwd();
const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');

/**
 * Approve a skill draft → write to project-level skills/<name>.md and mark approved.
 *
 * Body (optional): { force?: boolean } — if true, overwrite existing same-name file.
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

  let body: { force?: boolean } = {};
  try {
    body = (await req.json()) as { force?: boolean };
  } catch { /* no body is fine */ }

  const targetPath = path.join(SKILLS_DIR, `${draft.name}.md`);
  if (existsSync(targetPath) && !body.force) {
    return NextResponse.json(
      {
        error: `skills/${draft.name}.md already exists. Pass {force:true} to overwrite.`,
      },
      { status: 409 },
    );
  }

  try {
    writeFileSync(targetPath, draft.content, 'utf-8');
  } catch (err) {
    return NextResponse.json(
      { error: `failed to write skill file: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  updateSkillDraftStatus(draft.id, 'approved');
  return NextResponse.json({
    ok: true,
    written: `skills/${draft.name}.md`,
    bytes: Buffer.byteLength(draft.content, 'utf-8'),
  });
}
