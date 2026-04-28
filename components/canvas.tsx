'use client';

import { useEffect, useState } from 'react';
import { FolderOpen, FileText, Eye, Download, Boxes } from 'lucide-react';
import FileTree from './file-tree';
import { cn } from '@/lib/utils';
import type { AgentEvent, FileEntry } from '@/lib/types';

type Props = {
  sessionId: string;
  events: AgentEvent[];
  selectedFile: string | null;
  onSelectFile: (p: string | null) => void;
  isRunning: boolean;
};

export default function Canvas({ sessionId, events, selectedFile, onSelectFile, isRunning }: Props) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [content, setContent] = useState<{ text?: string; mime?: string; size?: number; isImage?: boolean } | null>(null);
  const [tab, setTab] = useState<'files' | 'preview'>('files');
  const [showInternals, setShowInternals] = useState(false);

  // Poll workspace files
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        const r = await fetch(`/api/tasks/${sessionId}/files?showInternals=${showInternals ? '1' : '0'}`);
        if (!r.ok || cancelled) return;
        const j = await r.json();
        setFiles(j.files ?? []);
        // Auto-select latest text_editor target if user hasn't manually picked one
        if (!selectedFile && j.files?.length) {
          const latestFromTools = inferLatestFile(events, j.files);
          if (latestFromTools) onSelectFile(latestFromTools);
        }
      } catch {}
      if (!cancelled) timer = setTimeout(tick, isRunning ? 1500 : 5000);
    }
    void tick();
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, isRunning, events.length, showInternals]);

  // Fetch content of selected file
  useEffect(() => {
    if (!selectedFile) { setContent(null); return; }
    let cancelled = false;
    async function load() {
      const r = await fetch(`/api/tasks/${sessionId}/files?path=${encodeURIComponent(selectedFile!)}`);
      if (cancelled) return;
      const ct = r.headers.get('content-type') ?? '';
      if (ct.startsWith('image/')) {
        setContent({ isImage: true, mime: ct });
        return;
      }
      try {
        const j = await r.json();
        if (j.error) {
          setContent({ text: `[error] ${j.error}` });
        } else {
          setContent({ text: j.content ?? '', size: j.size });
        }
      } catch {
        setContent({ text: '[error] could not parse response' });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [sessionId, selectedFile]);

  const previewable = !!selectedFile && /\.(html|pdf|svg)$/i.test(selectedFile);
  const artifacts = inferArtifacts(events, files);
  const selectedDownloadHref = selectedFile
    ? `/api/tasks/${sessionId}/files?path=${encodeURIComponent(selectedFile)}&raw=1&download=1`
    : '';
  const zipDownloadHref = `/api/tasks/${sessionId}/files?downloadAll=1&showInternals=${showInternals ? '1' : '0'}`;

  return (
    <section className="flex flex-col min-h-screen bg-bg-panel">
      <header className="px-4 py-2 border-b border-border-subtle flex items-center gap-1 text-xs">
        <button
          onClick={() => setTab('files')}
          className={cn('btn-ghost', tab === 'files' && 'bg-bg-hover text-text-primary')}
        >
          <FolderOpen className="w-3.5 h-3.5" /> 文件
        </button>
        {previewable && (
          <button
            onClick={() => setTab('preview')}
            className={cn('btn-ghost', tab === 'preview' && 'bg-bg-hover text-text-primary')}
          >
            <Eye className="w-3.5 h-3.5" /> 预览
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setShowInternals(v => !v)}
          className={cn('btn-ghost', showInternals && 'bg-bg-hover text-text-primary')}
          title="显示/隐藏系统目录"
        >
          {showInternals ? '隐藏系统文件' : '显示系统文件'}
        </button>
        {selectedFile && (
          <a
            href={selectedDownloadHref}
            className="btn-ghost"
            title="下载当前文件"
          >
            <Download className="w-3.5 h-3.5" /> 下载
          </a>
        )}
        <a
          href={zipDownloadHref}
          className={cn('btn-ghost', files.filter(f => !f.isDirectory).length === 0 && 'pointer-events-none opacity-50')}
          title="打包下载当前可见产物"
        >
          <Download className="w-3.5 h-3.5" /> 打包下载
        </a>
        <span className="text-text-muted">工作区 · {files.filter(f => !f.isDirectory).length} 个文件</span>
      </header>

      {tab === 'files' && (
        <div className="flex-1 grid grid-rows-[auto_1fr] min-h-0">
          <ArtifactPanel
            sessionId={sessionId}
            files={artifacts}
            showInternals={showInternals}
            onSelectFile={onSelectFile}
          />
          <div className="grid grid-cols-[200px_1fr] min-h-0">
          <div className="border-r border-border-subtle overflow-y-auto">
            <FileTree files={files} selected={selectedFile} onSelect={onSelectFile} />
          </div>
          <div className="overflow-auto">
            {!selectedFile && <EmptyState files={files.length} />}
            {selectedFile && content?.isImage && (
              <div className="p-4 flex items-center justify-center">
                <img
                  src={`/api/tasks/${sessionId}/files?path=${encodeURIComponent(selectedFile)}`}
                  alt={selectedFile}
                  className="max-w-full max-h-[80vh] rounded-md"
                />
              </div>
            )}
            {selectedFile && !content?.isImage && content?.text != null && (
              <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-words">{content.text}</pre>
            )}
          </div>
        </div>
        </div>
      )}

      {tab === 'preview' && selectedFile && (
        <div className="flex-1 bg-white">
          <iframe
            src={`/api/tasks/${sessionId}/files?path=${encodeURIComponent(selectedFile)}&raw=1`}
            sandbox="allow-scripts allow-same-origin"
            className="w-full h-full border-0"
            title="preview"
          />
        </div>
      )}
    </section>
  );
}

function ArtifactPanel({
  sessionId,
  files,
  showInternals,
  onSelectFile,
}: {
  sessionId: string;
  files: FileEntry[];
  showInternals: boolean;
  onSelectFile: (p: string | null) => void;
}) {
  if (!files.length) return null;
  return (
    <div className="border-b border-border-subtle px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-text-secondary mb-2">
        <Boxes className="w-3.5 h-3.5" />
        <span>本轮产物</span>
        <a
          href={`/api/tasks/${sessionId}/files?downloadAll=1&showInternals=${showInternals ? '1' : '0'}`}
          className="ml-auto btn-ghost py-0.5 px-1.5"
          title="打包下载全部可见产物"
        >
          <Download className="w-3.5 h-3.5" /> 全部打包
        </a>
      </div>
      <div className="flex flex-wrap gap-2">
        {files.slice(0, 8).map(f => (
          <div key={f.path} className="card px-2 py-1 inline-flex items-center gap-2 max-w-full">
            <button
              className="text-xs hover:underline truncate max-w-[240px]"
              onClick={() => onSelectFile(f.path)}
              title={f.path}
            >
              {f.path}
            </button>
            <a
              href={`/api/tasks/${sessionId}/files?path=${encodeURIComponent(f.path)}&raw=1&download=1`}
              className="btn-ghost p-1"
              title="下载"
            >
              <Download className="w-3.5 h-3.5" />
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ files }: { files: number }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-text-muted text-sm gap-2 p-8">
      <FileText className="w-10 h-10" />
      {files > 0 ? '从左侧选择一个文件查看' : '工作区为空，agent 工作时文件会出现在这里'}
    </div>
  );
}

/** Heuristic: pick the most recently created/edited file from toolUsed events. */
function inferLatestFile(events: AgentEvent[], files: FileEntry[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'toolUsed' || e.tool !== 'text_editor') continue;
    const param = (e.payload as any)?.param as string | undefined;
    if (!param) continue;
    // try to match either by exact relative path or by basename
    const base = param.split(/[\\/]/).pop();
    const match = files.find(f =>
      !f.isDirectory && (f.path === param || f.path === base || f.name === base)
    );
    if (match) return match.path;
  }
  return null;
}

function inferArtifacts(events: AgentEvent[], files: FileEntry[]): FileEntry[] {
  const byPath = new Map<string, FileEntry>();
  const available = files.filter(f => !f.isDirectory);

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'fileOperationPromotion') {
      const paths = ((e.payload as any)?.files ?? []) as string[];
      for (const p of paths) {
        const matched = available.find(f => f.path === p || f.name === p.split(/[\\/]/).pop());
        if (matched && !byPath.has(matched.path)) byPath.set(matched.path, matched);
      }
      if (byPath.size >= 8) break;
    }
    if (e.type !== 'toolUsed' || e.tool !== 'text_editor') continue;
    const param = (e.payload as any)?.param as string | undefined;
    if (!param) continue;
    const base = param.split(/[\\/]/).pop();
    const matched = available.find(f => f.path === param || f.name === base || f.path === base);
    if (matched && !byPath.has(matched.path)) byPath.set(matched.path, matched);
    if (byPath.size >= 8) break;
  }

  const fromEvents = Array.from(byPath.values());
  if (fromEvents.length >= 5) return fromEvents;

  const recent = [...available]
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
    .slice(0, 8);
  const merged = [...fromEvents];
  for (const f of recent) {
    if (!merged.some(x => x.path === f.path)) merged.push(f);
    if (merged.length >= 8) break;
  }
  return merged;
}
