import { NextResponse } from 'next/server';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getSession } from '@/lib/db';
import type { FileEntry } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WORKSPACES_DIR =
  process.env.MANUSCOPY_WORKSPACES_DIR ?? path.join(process.cwd(), 'workspaces');

const MAX_FILE_BYTES = 1024 * 1024; // 1 MB cap for file content fetch

function workspaceRoot(id: string): string {
  return path.join(WORKSPACES_DIR, id);
}

/** Refuse path traversal — ensure resolved path stays under workspace root. */
function safeResolve(root: string, rel: string): string | null {
  const resolved = path.resolve(root, rel);
  const normRoot = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(normRoot)) return null;
  return resolved;
}

// 系统内部目录——不展示给用户（这些是 agent 内部工作文件）
const HIDDEN_DIRS = new Set(['skills', 'scripts', 'knowledge', 'parsed', 'config', '.claude']);

async function listDirRecursive(root: string, rel = '', showInternals = false): Promise<FileEntry[]> {
  const abs = path.join(root, rel);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: FileEntry[] = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    // 顶层系统目录（skills/scripts/knowledge/parsed）默认隐藏
    if (rel === '' && !showInternals && HIDDEN_DIRS.has(ent.name)) continue;

    const childRel = path.posix.join(rel.replace(/\\/g, '/'), ent.name);
    const childAbs = path.join(abs, ent.name);
    if (ent.isDirectory()) {
      out.push({ path: childRel, name: ent.name, isDirectory: true });
      out.push(...(await listDirRecursive(root, childRel, showInternals)));
    } else if (ent.isFile()) {
      try {
        const st = await fs.stat(childAbs);
        out.push({
          path: childRel,
          name: ent.name,
          isDirectory: false,
          size: st.size,
          mtime: st.mtimeMs,
        });
      } catch {
        out.push({ path: childRel, name: ent.name, isDirectory: false });
      }
    }
  }
  return out;
}

function inferMime(p: string): string {
  const ext = path.extname(p).slice(1).toLowerCase();
  switch (ext) {
    case 'html': case 'htm': return 'text/html; charset=utf-8';
    case 'css':  return 'text/css; charset=utf-8';
    case 'js':   return 'application/javascript; charset=utf-8';
    case 'mjs':  return 'application/javascript; charset=utf-8';
    case 'json': return 'application/json; charset=utf-8';
    case 'md':   return 'text/markdown; charset=utf-8';
    case 'svg':  return 'image/svg+xml';
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'pdf':  return 'application/pdf';
    case 'txt':  return 'text/plain; charset=utf-8';
    default:     return 'text/plain; charset=utf-8';
  }
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const session = getSession(params.id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const root = workspaceRoot(params.id);
  const url = new URL(req.url);
  const filePath = url.searchParams.get('path');
  const raw = url.searchParams.get('raw') === '1'; // iframe 预览用：直接返原始字节

  if (!filePath) {
    // 返回文件树
    try {
      await fs.mkdir(root, { recursive: true });
    } catch {}
    const files = await listDirRecursive(root);
    files.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    return NextResponse.json({ files });
  }

  // 返回单个文件内容
  const abs = safeResolve(root, filePath);
  if (!abs) return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  try {
    const st = await fs.stat(abs);
    if (st.isDirectory()) return NextResponse.json({ error: 'path is a directory' }, { status: 400 });
    if (st.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: `file too large (>${MAX_FILE_BYTES} bytes)` }, { status: 413 });
    }
    const buf = await fs.readFile(abs);

    // 判断二进制
    const text = buf.toString('utf-8');
    const isBinary = /[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 4000));

    // 二进制 → 总是返原始字节
    if (isBinary) {
      return new NextResponse(buf, {
        headers: { 'content-type': inferMime(abs), 'cache-control': 'no-store' },
      });
    }

    // 文本 + ?raw=1 → 返原始字节（iframe 预览 / 直接下载用）
    if (raw) {
      return new NextResponse(buf, {
        headers: { 'content-type': inferMime(abs), 'cache-control': 'no-store' },
      });
    }

    // 默认：返 JSON 包装（前端文本查看器用）
    return NextResponse.json({ path: filePath, content: text, size: st.size, mtime: st.mtimeMs });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? String(err) }, { status: 404 });
  }
}
