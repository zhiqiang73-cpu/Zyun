#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dev_logs.py — 读 workspace 里 dev server 的日志（最近 N 行 + 错误高亮）。

使用:
    python scripts/dev_logs.py                # 最后 80 行
    python scripts/dev_logs.py --tail 200     # 最后 200 行
    python scripts/dev_logs.py --errors-only  # 只显示错误行
    python scripts/dev_logs.py --since 30     # 最近 30 秒的日志
"""

import sys
import io
import json
import time
import argparse
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

LOG_FILE = '.manuscopy_dev.log'
STATE_FILE = '.manuscopy_devserver.json'

ERR_PATTERNS = [
    'error', 'failed', 'enoent', 'eaddrinuse', 'syntaxerror',
    'typeerror', 'referenceerror', 'cannot find', 'fatal',
    '✗', '✖', '错误', '失败',
]


def cli():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tail', type=int, default=80)
    ap.add_argument('--errors-only', action='store_true')
    ap.add_argument('--since', type=float, default=0, help='Last N seconds')
    ap.add_argument('--quiet', action='store_true', help='Skip header')
    args = ap.parse_args()

    workspace = Path('.').resolve()
    log_path = workspace / LOG_FILE
    state_path = workspace / STATE_FILE

    if not log_path.exists():
        print(json.dumps({'ok': False, 'reason': 'no log file', 'hint': 'run dev_serve.py first'}, ensure_ascii=False))
        sys.exit(1)

    if not args.quiet:
        if state_path.exists():
            try:
                state = json.loads(state_path.read_text(encoding='utf-8'))
                print(f'--- dev server: {state.get("command", "?")} (pid={state.get("pid")}, port={state.get("port")}) ---')
            except Exception:
                pass

    try:
        text = log_path.read_text(encoding='utf-8', errors='replace')
    except Exception as e:
        print(f'[dev_logs] cannot read log: {e}', file=sys.stderr)
        sys.exit(1)

    lines = text.splitlines()

    if args.since > 0:
        # mtime cutoff
        cutoff = time.time() - args.since
        try:
            if log_path.stat().st_mtime < cutoff:
                lines = []
        except Exception:
            pass

    if args.errors_only:
        lines = [l for l in lines if any(p in l.lower() for p in ERR_PATTERNS)]

    # Tail last N
    out_lines = lines[-args.tail:] if args.tail > 0 else lines

    if not out_lines:
        print('[dev_logs] (no matching lines)')
        return

    print('\n'.join(out_lines))


if __name__ == '__main__':
    cli()
