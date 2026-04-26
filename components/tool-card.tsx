'use client';

import { useState } from 'react';
import { ChevronRight, ChevronDown, Terminal, FileEdit, Search, Globe, Image, Lightbulb, Loader2, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentEvent, ToolName } from '@/lib/types';

export default function ToolCard({ event, resultEvent }: { event: AgentEvent; resultEvent?: AgentEvent }) {
  const [open, setOpen] = useState(false);
  const tool = (event.tool ?? 'unknown') as ToolName;
  const final = resultEvent ?? event;
  const status = final.toolStatus ?? 'pending';

  const Icon = pickIcon(tool);
  const param = (event.payload as any)?.param as string | undefined;
  const output = (resultEvent?.payload as any)?.output as string | undefined;

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bg-hover transition-colors text-left"
      >
        <span className="text-text-muted">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
        <Icon className="w-4 h-4 text-text-secondary flex-shrink-0" />
        <span className="text-xs text-text-secondary font-mono uppercase tracking-wider">
          {tool}
        </span>
        <span className="text-xs text-text-muted">·</span>
        <span className="flex-1 text-sm truncate">{event.brief ?? event.toolAction ?? ''}</span>
        <StatusIcon status={status} />
      </button>

      {open && (
        <div className="border-t border-border-subtle p-3 space-y-2">
          {param && (
            <div>
              <div className="text-xs text-text-muted mb-1">{event.toolAction}</div>
              <pre className="text-xs font-mono bg-bg-base rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                {param}
              </pre>
            </div>
          )}
          {output && (
            <div>
              <div className="text-xs text-text-muted mb-1">输出</div>
              <pre className="text-xs font-mono bg-bg-base rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function pickIcon(tool: ToolName) {
  switch (tool) {
    case 'terminal': return Terminal;
    case 'text_editor': return FileEdit;
    case 'search': return Search;
    case 'web_fetch': return Globe;
    case 'media_viewer': return Image;
    case 'suggestion': return Lightbulb;
    default: return FileEdit;
  }
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'success') return <Check className="w-3.5 h-3.5 text-accent-green flex-shrink-0" />;
  if (status === 'error') return <X className="w-3.5 h-3.5 text-accent-red flex-shrink-0" />;
  return <Loader2 className="w-3.5 h-3.5 text-accent-blue animate-spin flex-shrink-0" />;
}
