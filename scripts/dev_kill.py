#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dev_kill.py — 停掉 workspace 里在跑的 dev server。

使用:
    python scripts/dev_kill.py
"""

import sys
import os
import io
import json
import time
import signal
import subprocess
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

STATE_FILE = '.manuscopy_devserver.json'


def is_pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == 'nt':
        try:
            out = subprocess.check_output(
                ['tasklist', '/FI', f'PID eq {pid}'],
                stderr=subprocess.DEVNULL, timeout=5,
            ).decode(errors='ignore')
            return str(pid) in out
        except Exception:
            return False
    else:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False


def kill_pid(pid: int) -> None:
    if pid <= 0:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(pid)],
                       stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL, timeout=10)
    else:
        try:
            os.kill(pid, signal.SIGTERM)
            time.sleep(1)
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        except OSError:
            pass


def main():
    workspace = Path('.').resolve()
    state_path = workspace / STATE_FILE
    if not state_path.exists():
        print(json.dumps({'ok': True, 'reason': 'no dev server running'}, ensure_ascii=False))
        return

    try:
        state = json.loads(state_path.read_text(encoding='utf-8'))
    except Exception as e:
        print(json.dumps({'ok': False, 'reason': f'cannot read state: {e}'}, ensure_ascii=False))
        sys.exit(1)

    pid = state.get('pid', 0)
    was_alive = is_pid_alive(pid)
    if was_alive:
        kill_pid(pid)
        time.sleep(1)

    try:
        state_path.unlink()
    except Exception:
        pass

    print(json.dumps({'ok': True, 'pid': pid, 'wasAlive': was_alive}, ensure_ascii=False))


if __name__ == '__main__':
    main()
