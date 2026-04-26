'use client';

import { useEffect, useState } from 'react';
import { FolderOpen, FileText, Eye } from 'lucide-react';
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

  // Poll workspace files
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        const r = await fetch(`/api/tasks/${sessionId}/files`);
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
  }, [sessionId, isRunning, events.length]);

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
        <span className="text-text-muted">工作区 · {files.filter(f => !f.isDirectory).length} 个文件</span>
      </header>

      {tab === 'files' && (
        <div className="flex-1 grid grid-cols-[200px_1fr] min-h-0">
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
