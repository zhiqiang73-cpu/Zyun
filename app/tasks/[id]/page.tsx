'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import ChatStream from '@/components/chat-stream';
import Canvas from '@/components/canvas';
import type { Session, AgentEvent } from '@/lib/types';

const STATUS_LABEL: Record<Session['status'], string> = {
  queued: '排队中',
  running: '执行中',
  paused: '已暂停',
  done: '已完成',
  error: '出错',
  stopped: '已停止',
};

export default function TaskPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`/api/tasks/${id}`);
        if (!r.ok || cancelled) return;
        const j = await r.json();
        if (!cancelled) setSession(j.session);
      } catch {
        // 服务器重启 / 临时断网 / 路径无效 —— 静默忽略，下个 tick 再试
      }
    }
    void load();
    const t = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [id]);

  if (!id) return null;

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r border-border-subtle p-4 space-y-3">
        <Link href="/" className="btn-ghost w-fit">
          <ChevronLeft className="w-4 h-4" />
          新建任务
        </Link>
        <div className="px-2 pt-4 text-xs text-text-muted">当前任务</div>
        <div className="px-2 text-sm font-medium leading-tight">{session?.title ?? '（加载中…）'}</div>
        <div className="px-2 text-xs text-text-muted">
          状态：<span className="text-text-secondary">{session ? STATUS_LABEL[session.status] : '—'}</span>
        </div>
      </aside>

      <main className="flex-1 grid grid-cols-2 min-h-screen">
        <ChatStream sessionId={id} session={session} onEvents={setEvents} />
        <Canvas
          sessionId={id}
          events={events}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          isRunning={session?.status === 'running' || session?.status === 'queued'}
        />
      </main>
    </div>
  );
}
