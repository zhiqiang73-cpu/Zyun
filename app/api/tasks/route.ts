import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { nanoid } from 'nanoid';
import { createSession, listSessions } from '@/lib/db';
import { runAgent, deriveTitle } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WORKSPACES_DIR =
  process.env.MANUSCOPY_WORKSPACES_DIR ?? path.join(process.cwd(), 'workspaces');

// 上传文件大小上限：单文件 20MB
const MAX_FILE_SIZE = 20 * 1024 * 1024;

const PROJECT_ROOT = process.cwd();
const PARSE_PDF_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'parse_pdf.py');

/**
 * PDF 上传后立即在后台预解析为 parsed/page_*.png + text.json + meta.json。
 * 这样 agent 启动时可直接 Read parsed/，省一轮 Bash 调用 ~3-5 秒。
 */
async function preprocessPdf(workspaceDir: string, pdfFilename: string): Promise<void> {
  if (!existsSync(PARSE_PDF_SCRIPT)) {
    console.warn('[manuscopy] parse_pdf.py not found, skip preprocess');
    return;
  }
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'python' : 'python3';
    const pdfRel = path.posix.join('uploads', pdfFilename);
    const proc = spawn(cmd, [PARSE_PDF_SCRIPT, pdfRel, '--out', 'parsed'], {
      cwd: workspaceDir,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', d => { stdout += d.toString(); });
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        console.log(`[manuscopy] preprocessed ${pdfFilename}`);
      } else {
        console.warn(`[manuscopy] preprocess ${pdfFilename} exit=${code} stderr=${stderr.slice(0, 300)}`);
      }
      resolve();
    });
    proc.on('error', (err) => {
      console.warn(`[manuscopy] preprocess ${pdfFilename} spawn error:`, err.message);
      resolve();
    });
    // 60s 超时
    setTimeout(() => { try { proc.kill(); } catch {} resolve(); }, 60_000);
  });
}

// 安全文件名：只允许字母数字 . _ - 中文，去掉路径分隔符
function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[^a-zA-Z0-9._\-一-龥]/g, '_').slice(0, 200);
}

export async function GET() {
  const sessions = listSessions();
  return NextResponse.json({ sessions });
}

export async function POST(req: Request) {
  const ct = req.headers.get('content-type') ?? '';
  let prompt = '';
  let files: File[] = [];

  if (ct.includes('multipart/form-data')) {
    try {
      const form = await req.formData();
      prompt = String(form.get('prompt') ?? '').trim();
      files = form.getAll('files').filter((v): v is File => v instanceof File);
    } catch (err: any) {
      return NextResponse.json({ error: 'invalid form data: ' + err.message }, { status: 400 });
    }
  } else {
    // 老 JSON 路径，向后兼容
    try {
      const body = await req.json();
      prompt = String(body?.prompt ?? '').trim();
    } catch {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }
  }

  if (!prompt && files.length === 0) {
    return NextResponse.json({ error: 'prompt or files is required' }, { status: 400 });
  }

  const id = nanoid(22);
  const now = Date.now();
  const workspaceDir = path.join(WORKSPACES_DIR, id);
  const uploadsDir = path.join(workspaceDir, 'uploads');
  await fs.mkdir(uploadsDir, { recursive: true });

  // 落盘所有上传文件
  const savedNames: string[] = [];
  for (const f of files) {
    if (f.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `file ${f.name} exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` },
        { status: 413 },
      );
    }
    const buf = Buffer.from(await f.arrayBuffer());
    const fname = safeFilename(f.name);
    await fs.writeFile(path.join(uploadsDir, fname), buf);
    savedNames.push(fname);
  }

  // 标题：如果只有文件没文字，用文件名当 prompt 默认
  let title = deriveTitle(prompt);
  if (!prompt && savedNames.length) {
    prompt = `处理上传的文件：${savedNames.join('、')}`;
    title = deriveTitle(prompt);
  }

  // ⚡ 加速：PDF 文件后台预解析（不阻塞响应；agent 启动时大概率已解析完）
  const pdfFiles = savedNames.filter(n => n.toLowerCase().endsWith('.pdf'));
  for (const pdf of pdfFiles) {
    void preprocessPdf(workspaceDir, pdf).catch(err => {
      console.error('[manuscopy] preprocessPdf failed', pdf, err);
    });
  }

  createSession({
    id,
    title,
    status: 'queued',
    taskMode: 'lite',
    costedCredits: 0,
    createdAt: now,
    updatedAt: now,
  });

  // 文件已经在 workspace/<id>/uploads/，runAgent 启动时 system prompt 会列出来
  void runAgent(id, prompt).catch((err) => {
    console.error('[manuscopy] agent run failed', id, err);
  });

  return NextResponse.json({ id, uploadedFiles: savedNames });
}
