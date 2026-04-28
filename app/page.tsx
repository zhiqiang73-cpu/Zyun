'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Sparkles, FileText, Loader2, Paperclip, X, FileType2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Session } from '@/lib/types';
import SkillDraftsChip from '@/components/skill-drafts-chip';

const QUICK_PROMPTS = [
  '把这张工程图 PDF 转成 FANUC G-code（2D 铣削）',
  '读 PDF 图纸提取所有孔的位置和直径，列成表格',
  '基于上传的工艺规范文档，写一段 PLC 西门子 S7 ladder 逻辑',
];

export default function Dashboard() {
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    void refreshSessions();
    const t = setInterval(refreshSessions, 3000);
    return () => clearInterval(t);
  }, []);

  async function refreshSessions() {
    try {
      const r = await fetch('/api/tasks');
      if (!r.ok) return;
      const j = await r.json();
      setSessions(j.sessions ?? []);
    } catch {}
  }

  function addFiles(newFiles: FileList | File[] | null) {
    if (!newFiles) return;
    const arr = Array.from(newFiles);
    setFiles(prev => {
      const merged = [...prev];
      for (const f of arr) {
        // 去重（同名+同大小视为相同）
        if (!merged.some(m => m.name === f.name && m.size === f.size)) {
          merged.push(f);
        }
      }
      return merged.slice(0, 10); // 上限 10 个
    });
  }

  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  }

  async function submit() {
    const text = prompt.trim();
    if ((!text && files.length === 0) || submitting) return;
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('prompt', text);
      for (const f of files) form.append('files', f);
      const r = await fetch('/api/tasks', { method: 'POST', body: form });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert('启动失败: ' + (j.error ?? r.status));
        return;
      }
      const { id } = await r.json();
      router.push(`/tasks/${id}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 border-r border-border-subtle p-4 space-y-4">
        <div className="flex items-center gap-2 px-2 py-1">
          <div className="w-7 h-7 rounded-md bg-accent-blue/20 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-accent-blue" />
          </div>
          <span className="font-semibold">Manuscopy</span>
        </div>

        <div className="text-xs text-text-muted px-2 pt-2">所有任务</div>
        <div className="space-y-1">
          {sessions.length === 0 && (
            <div className="text-xs text-text-muted px-2 italic">暂无任务</div>
          )}
          {sessions.map(s => (
            <Link
              key={s.id}
              href={`/tasks/${s.id}`}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-bg-hover text-sm group"
            >
              <StatusDot status={s.status} />
              <span className="flex-1 truncate">{s.title || '(未命名)'}</span>
            </Link>
          ))}
        </div>

        <div className="pt-3">
          <SkillDraftsChip />
        </div>
      </aside>

      <main
        className="flex-1 flex flex-col items-center justify-center px-8 py-12"
        onDragOver={e => { e.preventDefault(); }}
        onDrop={e => {
          e.preventDefault();
          if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
        }}
      >
        <div className="w-full max-w-3xl">
          <h1 className="text-3xl font-semibold text-center mb-2">我能为你做什么？</h1>
          <p className="text-text-muted text-center mb-8">
            CAD/PDF → CNC G-code · PLC 代码 · 工程问答
          </p>

          <div className="card p-3">
            {files.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {files.map((f, i) => (
                  <FileChip key={i} file={f} onRemove={() => removeFile(i)} />
                ))}
              </div>
            )}
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="描述任务，或拖拽 PDF 图纸到这里… (Cmd/Ctrl+Enter 提交)"
              rows={3}
              className="w-full bg-transparent border-none focus:outline-none resize-none text-sm"
            />
            <div className="flex justify-between items-center pt-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="btn-ghost"
                title="上传 PDF / 图片 / DXF"
              >
                <Paperclip className="w-4 h-4" />
                上传文件
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.png,.jpg,.jpeg,.dxf,.txt,.md"
                className="hidden"
                onChange={e => {
                  addFiles(e.target.files);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
              />
              <button
                onClick={submit}
                disabled={(!prompt.trim() && files.length === 0) || submitting}
                className="btn-primary"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {submitting ? '启动中…' : '开始'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mt-4">
            {QUICK_PROMPTS.map((p, i) => (
              <button
                key={i}
                onClick={() => setPrompt(p)}
                className="card p-3 text-left text-xs text-text-secondary hover:bg-bg-hover transition-colors"
              >
                <FileText className="w-3.5 h-3.5 inline mr-1.5 text-text-muted" />
                {p}
              </button>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

function FileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  return (
    <div className="inline-flex items-center gap-1.5 bg-bg-hover border border-border-subtle rounded-md pl-2 pr-1 py-1 text-xs">
      <FileType2 className="w-3.5 h-3.5 text-accent-blue" />
      <span className="max-w-[180px] truncate">{file.name}</span>
      <span className="text-text-muted">{formatSize(file.size)}</span>
      <button
        onClick={onRemove}
        className="ml-1 p-0.5 hover:bg-border-strong rounded"
        title="移除"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function StatusDot({ status }: { status: Session['status'] }) {
  const color =
    status === 'running' ? 'bg-accent-blue animate-pulse-soft' :
    status === 'done' ? 'bg-accent-green' :
    status === 'error' ? 'bg-accent-red' :
    status === 'queued' ? 'bg-accent-orange' :
    'bg-text-muted';
  return <span className={cn('w-2 h-2 rounded-full inline-block flex-shrink-0', color)} />;
}
