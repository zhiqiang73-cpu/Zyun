'use client';

import { Check, Circle, Loader2, ListTodo } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentEvent, PlanTask } from '@/lib/types';

export default function PlanView({ event }: { event: AgentEvent }) {
  const tasks: PlanTask[] = ((event.payload as any)?.tasks ?? []) as PlanTask[];
  if (!tasks.length) return null;

  const doneCount = tasks.filter(t => t.status === 'done').length;

  return (
    <div className="card p-3">
      <div className="flex items-center gap-2 text-xs text-text-secondary mb-2">
        <ListTodo className="w-3.5 h-3.5" />
        <span>执行计划</span>
        <span className="text-text-muted">· {doneCount}/{tasks.length}</span>
      </div>
      <ol className="space-y-1.5">
        {tasks.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <StepIcon status={t.status} />
            <span className={cn(
              'flex-1',
              t.status === 'done' && 'text-text-muted line-through',
              t.status === 'doing' && 'text-text-primary font-medium',
              t.status === 'todo' && 'text-text-secondary',
              t.status === 'skipped' && 'text-text-muted italic',
            )}>
              {t.title}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepIcon({ status }: { status: PlanTask['status'] }) {
  if (status === 'done') return <Check className="w-4 h-4 text-accent-green flex-shrink-0 mt-0.5" />;
  if (status === 'doing') return <Loader2 className="w-4 h-4 text-accent-blue animate-spin flex-shrink-0 mt-0.5" />;
  if (status === 'skipped') return <Circle className="w-4 h-4 text-text-muted flex-shrink-0 mt-0.5" />;
  return <Circle className="w-4 h-4 text-text-muted flex-shrink-0 mt-0.5" />;
}
