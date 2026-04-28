'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, FileCheck, FileX, Loader2, RefreshCw } from 'lucide-react';

type SkillDraft = {
  id: string;
  name: string;
  description: string;
  content: string;
  derived_from: string[];
  status: 'pending' | 'approved' | 'rejected';
  reject_reason: string | null;
  created_at: number;
  updated_at: number;
};

type Counts = { pending: number; approved: number; rejected: number };

const STATUS_LABEL: Record<SkillDraft['status'], string> = {
  pending: '待审核',
  approved: '已采纳',
  rejected: '已拒绝',
};

export default function SkillDraftsPage() {
  const [drafts, setDrafts] = useState<SkillDraft[]>([]);
  const [counts, setCounts] = useState<Counts>({ pending: 0, approved: 0, rejected: 0 });
  const [filter, setFilter] = useState<SkillDraft['status']>('pending');
  const [selected, setSelected] = useState<string | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await fetch(`/api/skills/drafts?status=${filter}`);
      if (!r.ok) return;
      const j = await r.json();
      setDrafts(j.drafts ?? []);
      setCounts(j.counts ?? { pending: 0, approved: 0, rejected: 0 });
    } catch {
      // silently ignore
    }
  }

  useEffect(() => {
    void refresh();
  }, [filter]);

  const current = selected ? drafts.find(d => d.id === selected) ?? null : drafts[0] ?? null;

  async function approve(id: string, force = false) {
    setActionInProgress(id);
    setActionError(null);
    try {
      const r = await fetch(`/api/skills/drafts/${id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 409 && /already exists/.test(j.error ?? '')) {
          if (confirm(`${j.error}\n\n确定要覆盖吗？`)) {
            await approve(id, true);
            return;
          }
        }
        setActionError(j.error ?? `approve failed (${r.status})`);
        return;
      }
      await refresh();
    } finally {
      setActionInProgress(null);
    }
  }

  async function reject(id: string) {
    const reason = window.prompt('（可选）拒绝理由：');
    if (reason === null) return; // user cancelled
    setActionInProgress(id);
    setActionError(null);
    try {
      const r = await fetch(`/api/skills/drafts/${id}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setActionError(j.error ?? `reject failed (${r.status})`);
        return;
      }
      await refresh();
    } finally {
      setActionInProgress(null);
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-72 border-r border-border-subtle p-4 space-y-3">
        <Link href="/" className="btn-ghost w-fit">
          <ChevronLeft className="w-4 h-4" />
          返回
        </Link>

        <div className="px-2 pt-3 text-sm font-semibold">Skill 审核</div>

        <div className="flex gap-1 px-1">
          {(['pending', 'approved', 'rejected'] as const).map(s => (
            <button
              key={s}
              onClick={() => {
                setFilter(s);
                setSelected(null);
              }}
              className={`text-xs px-2 py-1 rounded ${
                filter === s
                  ? 'bg-accent-blue/20 text-accent-blue'
                  : 'text-text-muted hover:bg-bg-hover'
              }`}
            >
              {STATUS_LABEL[s]} ({counts[s]})
            </button>
          ))}
          <button
            onClick={() => void refresh()}
            className="ml-auto btn-ghost px-1.5 py-1"
            title="刷新"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="space-y-1">
          {drafts.length === 0 && (
            <div className="text-xs text-text-muted px-2 italic py-3">该状态下暂无 draft</div>
          )}
          {drafts.map(d => (
            <button
              key={d.id}
              onClick={() => setSelected(d.id)}
              className={`w-full text-left px-2 py-1.5 rounded-md text-sm ${
                (selected ?? drafts[0]?.id) === d.id ? 'bg-bg-hover' : 'hover:bg-bg-hover'
              }`}
            >
              <div className="font-medium truncate">{d.name}</div>
              <div className="text-[11px] text-text-muted truncate">
                {new Date(d.created_at).toLocaleString()} · 来自 {d.derived_from.length} 条反思
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex-1 p-6 max-w-4xl">
        {!current ? (
          <div className="text-text-muted text-sm pt-8">选择一个 draft 查看内容。</div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h1 className="text-xl font-semibold">{current.name}</h1>
              <span className="text-xs px-2 py-0.5 rounded bg-bg-hover text-text-muted">
                {STATUS_LABEL[current.status]}
              </span>
              <span className="text-xs text-text-muted">
                {new Date(current.created_at).toLocaleString()}
              </span>
            </div>

            <div className="text-sm text-text-secondary">{current.description}</div>

            {current.derived_from.length > 0 && (
              <div className="text-xs text-text-muted">
                蒸馏自 {current.derived_from.length} 条反思: {current.derived_from.slice(0, 6).join(', ')}
                {current.derived_from.length > 6 && ' …'}
              </div>
            )}

            {current.status === 'rejected' && current.reject_reason && (
              <div className="text-xs text-accent-red bg-accent-red/10 p-2 rounded">
                拒绝理由：{current.reject_reason}
              </div>
            )}

            {actionError && (
              <div className="text-xs text-accent-red bg-accent-red/10 p-2 rounded">
                {actionError}
              </div>
            )}

            {current.status === 'pending' && (
              <div className="flex gap-2">
                <button
                  onClick={() => void approve(current.id)}
                  disabled={actionInProgress === current.id}
                  className="btn-primary"
                >
                  {actionInProgress === current.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <FileCheck className="w-4 h-4" />
                  )}
                  采纳并写入 skills/{current.name}.md
                </button>
                <button
                  onClick={() => void reject(current.id)}
                  disabled={actionInProgress === current.id}
                  className="btn-ghost"
                >
                  <FileX className="w-4 h-4" />
                  拒绝
                </button>
              </div>
            )}

            <pre className="card p-4 text-xs font-mono overflow-auto whitespace-pre-wrap">
              {current.content}
            </pre>
          </div>
        )}
      </main>
    </div>
  );
}
