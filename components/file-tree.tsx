'use client';

import { File, Folder, FileText, FileCode, FileImage, FileType } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FileEntry } from '@/lib/types';

type Props = {
  files: FileEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
};

export default function FileTree({ files, selected, onSelect }: Props) {
  if (!files.length) {
    return <div className="text-xs text-text-muted px-3 py-2 italic">暂无文件</div>;
  }
  return (
    <div className="flex flex-col">
      {files.map(f => (
        <button
          key={f.path}
          onClick={() => !f.isDirectory && onSelect(f.path)}
          disabled={f.isDirectory}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 text-xs text-left',
            f.isDirectory ? 'text-text-muted cursor-default' : 'hover:bg-bg-hover',
            selected === f.path && 'bg-accent-blue/15 text-text-primary',
          )}
          style={{ paddingLeft: 12 + indent(f.path) * 12 }}
        >
          <FileIcon entry={f} />
          <span className="truncate flex-1">{f.name}</span>
          {!f.isDirectory && f.size != null && (
            <span className="text-text-muted text-[10px]">{formatSize(f.size)}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function FileIcon({ entry }: { entry: FileEntry }) {
  if (entry.isDirectory) return <Folder className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />;
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
  if (['py', 'js', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'sh', 'md'].includes(ext))
    return <FileCode className="w-3.5 h-3.5 text-accent-blue/80 flex-shrink-0" />;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext))
    return <FileImage className="w-3.5 h-3.5 text-accent-green/80 flex-shrink-0" />;
  if (['txt', 'log'].includes(ext))
    return <FileText className="w-3.5 h-3.5 text-text-secondary flex-shrink-0" />;
  return <File className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />;
}

function indent(p: string): number {
  return Math.max(0, p.split('/').length - 1);
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
