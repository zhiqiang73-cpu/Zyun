'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Lightbulb, Loader2 } from 'lucide-react';

type Counts = { pending: number; approved: number; rejected: number };

/**
 * Sidebar chip showing pending skill draft count + a "Distill now" trigger.
 * Quietly shows nothing when there's neither pending drafts nor any backlog ready.
 */
export default function SkillDraftsChip() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [pendingReflections, setPendingReflections] = useState<number | null>(null);
  const [threshold, setThreshold] = useState<number>(5);
  const [running, setRunning] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  async function refresh() {
    try {
      const [r1, r2] = await Promise.all([
        fetch('/api/skills/drafts'),
        fetch('/api/skills/distill'),
      ]);
      if (r1.ok) {
        const j = await r1.json();
        setCounts(j.counts ?? null);
      }
      if (r2.ok) {
        const j = await r2.json();
        setPendingReflections(j.pending_count ?? 0);
        if (typeof j.threshold === 'number') setThreshold(j.threshold);
      }
    } catch {
      // ignore — UI silently degrades
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, []);

  async function distillNow(force: boolean) {
    if (running) return;
    setRunning(true);
    setHint(null);
    try {
      const r = await fetch('/api/skills/distill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        setHint(`✓ 蒸馏完成：${j.name}`);
      } else if (j.reason?.startsWith?.('NO_PATTERN')) {
        setHint('未发现可沉淀的新 pattern');
      } else {
        setHint(j.reason ?? '蒸馏失败');
      }
      void refresh();
    } catch (err) {
      setHint('蒸馏请求失败');
    } finally {
      setRunning(false);
      setTimeout(() => setHint(null), 6000);
    }
  }

  if (counts === null) return null;

  const pendingDrafts = counts.pending;
  const ready = (pendingReflections ?? 0) >= threshold;

  // 完全没有内容：什么都不显示
  if (pendingDrafts === 0 && (pendingReflections ?? 0) === 0) return null;

  return (
    <div className="border border-border-subtle rounded-md p-3 space-y-2 bg-bg-card">
      <div className="flex items-center gap-2 text-xs font-medium">
        <Lightbulb className="w-3.5 h-3.5 text-accent-orange" />
        Skill 学习
      </div>

      {pendingDrafts > 0 && (
        <Link
          href="/skills/drafts"
          className="block text-xs px-2 py-1.5 rounded bg-accent-orange/10 hover:bg-accent-orange/20 text-accent-orange"
        >
          待审核 draft：<span className="font-semibold">{pendingDrafts}</span>
        </Link>
      )}

      {(pendingReflections ?? 0) > 0 && (
        <div className="text-[11px] text-text-muted">
          反思 backlog：{pendingReflections}
          {ready ? ' （可蒸馏）' : ` / ${threshold} 才会自动建议`}
        </div>
      )}

      {(pendingReflections ?? 0) > 0 && (
        <button
          onClick={() => distillNow(!ready)}
          disabled={running}
          className="btn-ghost w-full text-xs justify-center"
          title={ready ? '立刻蒸馏' : '未达阈值，强制运行'}
        >
          {running ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 蒸馏中…
            </>
          ) : (
            <>立即蒸馏</>
          )}
        </button>
      )}

      {hint && <div className="text-[11px] text-text-muted leading-tight">{hint}</div>}
    </div>
  );
}
