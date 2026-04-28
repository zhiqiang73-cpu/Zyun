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

function dosDateTime(d = new Date()): { date: number; time: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipLocalHeader(name: Buffer, data: Buffer, crc: number, mod: { date: number; time: number }): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4); // version needed
  h.writeUInt16LE(0x0800, 6); // UTF-8 names
  h.writeUInt16LE(0, 8); // store
  h.writeUInt16LE(mod.time, 10);
  h.writeUInt16LE(mod.date, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(data.length, 18);
  h.writeUInt32LE(data.length, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  return h;
}

function zipCentralHeader(
  name: Buffer,
  data: Buffer,
  crc: number,
  mod: { date: number; time: number },
  offset: number,
): Buffer {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4); // version made by
  h.writeUInt16LE(20, 6); // version needed
  h.writeUInt16LE(0x0800, 8); // UTF-8 names
  h.writeUInt16LE(0, 10); // store
  h.writeUInt16LE(mod.time, 12);
  h.writeUInt16LE(mod.date, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(data.length, 20);
  h.writeUInt32LE(data.length, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt16LE(0, 30); // extra length
  h.writeUInt16LE(0, 32); // comment length
  h.writeUInt16LE(0, 34); // disk start
  h.writeUInt16LE(0, 36); // internal attrs
  h.writeUInt32LE(0, 38); // external attrs
  h.writeUInt32LE(offset, 42);
  return h;
}

function zipEnd(entries: number, centralSize: number, centralOffset: number): Buffer {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(0, 4);
  h.writeUInt16LE(0, 6);
  h.writeUInt16LE(entries, 8);
  h.writeUInt16LE(entries, 10);
  h.writeUInt32LE(centralSize, 12);
  h.writeUInt32LE(centralOffset, 16);
  h.writeUInt16LE(0, 20);
  return h;
}

async function createZip(root: string, files: FileEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const abs = safeResolve(root, f.path);
    if (!abs) continue;
    let data: Buffer;
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(abs);
      if (!st.isFile()) continue;
      data = await fs.readFile(abs);
    } catch {
      continue;
    }

    const name = Buffer.from(f.path.replace(/\\/g, '/'), 'utf-8');
    const crc = crc32(data);
    const mod = dosDateTime(st.mtime);
    const local = zipLocalHeader(name, data, crc, mod);
    chunks.push(local, name, data);
    central.push(zipCentralHeader(name, data, crc, mod, offset), name);
    offset += local.length + name.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  return Buffer.concat([...chunks, ...central, zipEnd(central.length / 2, centralSize, centralOffset)]);
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
  const download = url.searchParams.get('download') === '1';
  const showInternals = url.searchParams.get('showInternals') === '1';
  const downloadAll = url.searchParams.get('downloadAll') === '1';

  if (downloadAll) {
    const allFiles = await listDirRecursive(root, '', showInternals);
    const visibleFiles = allFiles.filter(f => !f.isDirectory);
    const productFiles = visibleFiles.filter(f => !f.path.startsWith('uploads/'));
    const filesToZip = productFiles.length ? productFiles : visibleFiles;
    const zip = await createZip(root, filesToZip);
    return new NextResponse(new Uint8Array(zip), {
      headers: {
        'content-type': 'application/zip',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="manuscopy-${params.id}.zip"`,
      },
    });
  }

  if (!filePath) {
    // 返回文件树
    try {
      await fs.mkdir(root, { recursive: true });
    } catch {}
    const files = await listDirRecursive(root, '', showInternals);
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
    if (!raw && !download && st.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: `file too large (>${MAX_FILE_BYTES} bytes)` }, { status: 413 });
    }
    const buf = await fs.readFile(abs);
    const contentType = inferMime(abs);
    const fileName = path.basename(abs);
    const baseHeaders: Record<string, string> = {
      'content-type': contentType,
      'cache-control': 'no-store',
    };
    if (download) {
      baseHeaders['content-disposition'] = `attachment; filename="${encodeURIComponent(fileName)}"`;
    }

    // 判断二进制
    const text = buf.toString('utf-8');
    const isBinary = /[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 4000));

    // 二进制 → 总是返原始字节
    if (isBinary) {
      return new NextResponse(buf, { headers: baseHeaders });
    }

    // 文本 + ?raw=1 → 返原始字节（iframe 预览 / 直接下载用）
    if (raw || download) {
      return new NextResponse(buf, { headers: baseHeaders });
    }

    // 默认：返 JSON 包装（前端文本查看器用）
    return NextResponse.json({ path: filePath, content: text, size: st.size, mtime: st.mtimeMs });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? String(err) }, { status: 404 });
  }
}
