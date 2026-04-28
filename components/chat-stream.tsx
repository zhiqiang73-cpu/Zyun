'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, User, Bot, Send, Square } from 'lucide-react';
import PlanView from './plan-view';
import ToolCard from './tool-card';
import { cn } from '@/lib/utils';
import type { AgentEvent, EventsResponse, PlanTask, Session } from '@/lib/types';

type Props = {
  sessionId: string;
  session: Session | null;
  onEvents?: (events: AgentEvent[]) => void;
};

export default function ChatStream({ sessionId, session, onEvents }: Props) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [followUp, setFollowUp] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const lastTsRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onEvents?.(events);
  }, [events, onEvents]);

  // Polling — 一直跑（轻量），任务结束后降到 3s/次省点资源
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      let isTerminal = false;
      try {
        const url = `/api/tasks/${sessionId}/events?after=${lastTsRef.current}`;
        const r = await fetch(url);
        if (!r.ok) return;
        const j: EventsResponse = await r.json();
        if (cancelled) return;
        if (j.events.length) {
          lastTsRef.current = j.nextAfter;
          setEvents(prev => [...prev, ...j.events]);
        }
        isTerminal = ['done', 'error', 'stopped'].includes(j.sessionStatus);
      } catch {}
      if (!cancelled) timer = setTimeout(tick, isTerminal ? 3000 : 1000);
    }
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer!);
    };
  }, [sessionId]);

  async function submitFollowUp() {
    const content = followUp.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const r = await fetch(`/api/tasks/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert('发送失败：' + (j.error ?? r.status));
        return;
      }
      setFollowUp('');
      // 轮询会自动捕获新事件，不用手动加
    } finally {
      setSending(false);
    }
  }

  async function stopTask() {
    if (stopping || !isRunning) return;
    setStopping(true);
    try {
      const r = await fetch(`/api/tasks/${sessionId}/stop`, { method: 'POST' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert('停止失败：' + (j.error ?? r.status));
      }
    } finally {
      setStopping(false);
    }
  }

  // Auto-scroll to bottom on new events
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length]);

  // Group consecutive events for nicer rendering. We render:
  //   - chat events (user/assistant) as bubbles
  //   - planUpdate as the latest TODO list
  //   - toolUsed as cards (we de-duplicate pending+success/error pairs by useId)
  const renderable = collapseEvents(events);
  const latestPlan = findLatestPlan(events);
  const isRunning = session?.status === 'running' || session?.status === 'queued';

  return (
    <section className="border-r border-border-subtle flex flex-col min-h-screen">
      <header className="px-6 py-3 border-b border-border-subtle flex items-center gap-2 text-sm">
        <Bot className="w-4 h-4 text-accent-blue" />
        <span className="font-medium">Manuscopy</span>
        <span className="text-xs text-text-muted">
          {isRunning ? '思考中…' : session?.status === 'done' ? '已完成' : session?.status === 'error' ? '出错' : ''}
        </span>
        <div className="flex-1" />
        {isRunning && (
          <button
            onClick={stopTask}
            disabled={stopping}
            className="btn-ghost text-accent-red"
            title="停止当前任务"
          >
            {stopping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
            {stopping ? '停止中…' : '停止'}
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {renderable.map(item => {
          if (item.kind === 'chat') {
            return <ChatBubble key={item.event.id} event={item.event} />;
          }
          if (item.kind === 'plan') {
            return <PlanView key={item.event.id} event={item.event} />;
          }
          if (item.kind === 'tool') {
            return <ToolCard key={item.event.id} event={item.event} resultEvent={item.result} />;
          }
          return null;
        })}
        {isRunning && <ThinkingIndicator />}
        <div ref={bottomRef} />
      </div>

      {/* Follow-up 输入框 */}
      <div className="border-t border-border-subtle p-3">
        <div className="card p-2 flex items-end gap-2">
          <textarea
            value={followUp}
            onChange={e => setFollowUp(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submitFollowUp();
              }
            }}
            placeholder={isRunning ? '任务进行中，可追加约束或纠偏…  (Cmd/Ctrl+Enter 发送)' : '继续对话或追加指令…  (Cmd/Ctrl+Enter 发送)'}
            rows={2}
            className="flex-1 bg-transparent border-none focus:outline-none resize-none text-sm"
          />
          <button
            onClick={submitFollowUp}
            disabled={!followUp.trim() || sending}
            className="btn-primary"
            title="发送（Cmd/Ctrl+Enter）"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </section>
  );
}

function ChatBubble({ event }: { event: AgentEvent }) {
  const isUser = event.sender === 'user';
  return (
    <div className={cn('flex gap-3', isUser && 'flex-row-reverse')}>
      <div className={cn(
        'w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0',
        isUser ? 'bg-bg-card' : 'bg-accent-blue/20',
      )}>
        {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5 text-accent-blue" />}
      </div>
      <div className={cn(
        'max-w-[85%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap break-words',
        isUser ? 'bg-bg-card' : 'bg-transparent',
      )}>
        {event.content}
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-xs text-text-muted px-10">
      <Loader2 className="w-3 h-3 animate-spin" />
      思考中…
    </div>
  );
}

// ---- Helpers ------------------------------------------------------

type RenderItem =
  | { kind: 'chat'; event: AgentEvent }
  | { kind: 'plan'; event: AgentEvent }
  | { kind: 'tool'; event: AgentEvent; result?: AgentEvent };

function collapseEvents(events: AgentEvent[]): RenderItem[] {
  const items: RenderItem[] = [];
  let lastPlanIdx = -1;
  // Map of useId → index in items, used to attach result event to its pending event
  const pendingByUseId = new Map<string, number>();

  for (const e of events) {
    if (e.type === 'chat') {
      // Skip empty / bookkeeping chat events
      if (!e.content?.trim()) continue;
      items.push({ kind: 'chat', event: e });
      continue;
    }
    if (e.type === 'planUpdate') {
      // Replace previous plan view (so UI shows only the latest)
      if (lastPlanIdx >= 0) items[lastPlanIdx] = { kind: 'plan', event: e };
      else { lastPlanIdx = items.length; items.push({ kind: 'plan', event: e }); }
      continue;
    }
    if (e.type === 'toolUsed') {
      const useId = (e.payload as any)?.useId;
      // If this is the result event matching a pending one — attach
      if (useId && pendingByUseId.has(useId) && (e.toolStatus === 'success' || e.toolStatus === 'error')) {
        const idx = pendingByUseId.get(useId)!;
        const target = items[idx];
        if (target?.kind === 'tool') {
          items[idx] = { ...target, result: e };
        }
        pendingByUseId.delete(useId);
        continue;
      }
      // New pending tool call
      const idx = items.length;
      items.push({ kind: 'tool', event: e });
      if (useId) pendingByUseId.set(useId, idx);
      continue;
    }
    // Other types (statusUpdate / liveStatus / chatDelta / etc.) are not rendered in the chat
  }
  return items;
}

function findLatestPlan(events: AgentEvent[]): AgentEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'planUpdate') return events[i];
  }
  return null;
}
