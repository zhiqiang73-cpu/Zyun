#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dev_serve.py — 在 workspace 里启动 dev server，后台运行，把 pid+port+log 写到
                 .manuscopy_devserver.json。Manuscopy UI 检测到这个文件就显示
                 "Live Preview"。

自动检测项目类型：
  - package.json 有 dev script → npm run dev
  - vite.config.* → npm run dev
  - 只有 index.html  → python -m http.server （静态）
  - 用户 --cmd "..." 强制覆盖

使用:
    python scripts/dev_serve.py                # 自动检测 + 启动
    python scripts/dev_serve.py --port 3100    # 指定端口（默认从 3100 起）
    python scripts/dev_serve.py --cmd "npm run dev"  # 自定义命令
    python scripts/dev_serve.py --status       # 查询当前状态（不启动）
    python scripts/dev_serve.py --restart      # 杀旧进程后重启

返回 JSON:
    {"ok": true, "pid": 12345, "port": 3100, "url": "http://localhost:3100",
     "command": "npm run dev", "log": ".manuscopy_dev.log"}

⚠️ 强制后台 spawn —— 不会阻塞 agent；agent 可以紧接着 dev_logs.py 看日志。
"""

import sys
import os
import io
import json
import time
import socket
import argparse
import subprocess
import signal
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

STATE_FILE = '.manuscopy_devserver.json'
LOG_FILE = '.manuscopy_dev.log'


def is_port_free(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.5)
    try:
        s.bind(('127.0.0.1', port))
        s.close()
        return True
    except OSError:
        try:
            s.close()
        except Exception:
            pass
        return False


def find_free_port(start: int = 3100, end: int = 3200) -> int:
    for p in range(start, end):
        if is_port_free(p):
            return p
    raise RuntimeError(f'no free port in {start}-{end}')


def detect_command(workspace: Path) -> tuple[str, str]:
    """Returns (command, kind). kind ∈ {'next', 'vite', 'npm-dev', 'static', 'unknown'}."""
    pkg = workspace / 'package.json'
    if pkg.exists():
        try:
            obj = json.loads(pkg.read_text(encoding='utf-8'))
            scripts = obj.get('scripts', {})
            deps = {**obj.get('dependencies', {}), **obj.get('devDependencies', {})}
            if 'next' in deps:
                return ('npm run dev', 'next')
            if 'vite' in deps:
                return ('npm run dev', 'vite')
            if 'dev' in scripts:
                return ('npm run dev', 'npm-dev')
            if 'start' in scripts:
                return ('npm start', 'npm-start')
        except Exception:
            pass
    if (workspace / 'index.html').exists():
        return ('python -m http.server {port}', 'static')
    return ('', 'unknown')


def is_pid_alive(pid: int) -> bool:
    """Check if a PID is still running. Cross-platform best-effort."""
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
        try:
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(pid)],
                           stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL, timeout=10)
        except Exception:
            pass
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


def read_state(workspace: Path) -> dict | None:
    f = workspace / STATE_FILE
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text(encoding='utf-8'))
    except Exception:
        return None


def write_state(workspace: Path, state: dict) -> None:
    (workspace / STATE_FILE).write_text(json.dumps(state, ensure_ascii=False, indent=2),
                                         encoding='utf-8')


def stop_existing(workspace: Path) -> bool:
    state = read_state(workspace)
    if not state:
        return False
    pid = state.get('pid', 0)
    if pid and is_pid_alive(pid):
        kill_pid(pid)
        time.sleep(1)
    try:
        (workspace / STATE_FILE).unlink()
    except Exception:
        pass
    return True


def start_server(workspace: Path, command: str, port: int) -> dict:
    log_path = workspace / LOG_FILE
    # 截断旧日志
    log_path.write_text('', encoding='utf-8')

    # Substitute {port} / {PORT} placeholders
    real_cmd = command.replace('{port}', str(port)).replace('{PORT}', str(port))

    env = os.environ.copy()
    env['PORT'] = str(port)
    # Next/Vite 都尊重 PORT；额外给个 NEXT_TELEMETRY_DISABLED 让日志干净
    env.setdefault('NEXT_TELEMETRY_DISABLED', '1')
    env.setdefault('CI', '1')        # 让 npm 别走交互
    env.setdefault('FORCE_COLOR', '0')

    log_fd = open(log_path, 'a', encoding='utf-8', errors='replace', buffering=1)
    log_fd.write(f'[manuscopy] starting: {real_cmd} (port={port}, cwd={workspace})\n')
    log_fd.flush()

    if os.name == 'nt':
        # Windows: 用 shell=True 让 npm.cmd 能解析
        # 不用 CREATE_NEW_PROCESS_GROUP，否则 ctrl+c 杀不掉子进程
        creationflags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0
        proc = subprocess.Popen(
            real_cmd,
            cwd=str(workspace),
            shell=True,
            stdout=log_fd,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=env,
            creationflags=creationflags,
        )
    else:
        proc = subprocess.Popen(
            real_cmd,
            cwd=str(workspace),
            shell=True,
            stdout=log_fd,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=env,
            preexec_fn=os.setsid,
        )

    state = {
        'pid': proc.pid,
        'port': port,
        'url': f'http://localhost:{port}',
        'command': real_cmd,
        'log': LOG_FILE,
        'startedAt': int(time.time() * 1000),
    }
    write_state(workspace, state)
    return state


def wait_until_ready(workspace: Path, port: int, timeout: float = 25.0) -> tuple[bool, str]:
    """Probe port + scan log for ERROR keywords. Returns (alive, reason)."""
    log_path = workspace / LOG_FILE
    deadline = time.time() + timeout
    while time.time() < deadline:
        # Port up?
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.3)
        try:
            s.connect(('127.0.0.1', port))
            s.close()
            return (True, 'port-listening')
        except Exception:
            try:
                s.close()
            except Exception:
                pass

        # Look for fatal patterns in log
        try:
            tail = log_path.read_text(encoding='utf-8', errors='replace')[-3000:]
            low = tail.lower()
            if any(k in low for k in ['error: cannot find module',
                                       'syntaxerror', 'enoent', 'eaddrinuse',
                                       'failed to compile', 'fatal:']):
                return (False, 'log-error-detected')
        except Exception:
            pass

        time.sleep(0.5)
    return (False, 'timeout')


def cli():
    ap = argparse.ArgumentParser(description='Start a dev server in the current workspace, in the background.')
    ap.add_argument('--port', type=int, default=0, help='Port (default: auto-pick free 3100-3199)')
    ap.add_argument('--cmd', help='Custom command (overrides auto-detect)')
    ap.add_argument('--restart', action='store_true', help='Stop existing first')
    ap.add_argument('--status', action='store_true', help='Print status and exit (no start)')
    ap.add_argument('--wait', type=float, default=20.0, help='Seconds to wait for port up (default 20)')
    ap.add_argument('--no-wait', action='store_true', help='Do not wait for ready check (return immediately)')
    args = ap.parse_args()

    workspace = Path('.').resolve()

    if args.status:
        state = read_state(workspace)
        if not state:
            print(json.dumps({'ok': False, 'reason': 'no dev server state file'}, ensure_ascii=False))
            return
        alive = is_pid_alive(state.get('pid', 0))
        state['alive'] = alive
        print(json.dumps(state, ensure_ascii=False))
        return

    if args.restart:
        stopped = stop_existing(workspace)
        if stopped:
            print('[dev_serve] stopped existing server', file=sys.stderr)

    # Already running?
    existing = read_state(workspace)
    if existing and is_pid_alive(existing.get('pid', 0)):
        existing['alive'] = True
        existing['ok'] = True
        existing['reason'] = 'already-running'
        print(json.dumps(existing, ensure_ascii=False))
        return

    # Detect command
    if args.cmd:
        command = args.cmd
        kind = 'custom'
    else:
        command, kind = detect_command(workspace)
        if not command:
            print(json.dumps({
                'ok': False,
                'reason': 'no-runnable-project',
                'hint': 'workspace lacks package.json with dev script and lacks index.html',
            }, ensure_ascii=False))
            sys.exit(1)

    port = args.port if args.port > 0 else find_free_port()

    state = start_server(workspace, command, port)
    state['kind'] = kind
    state['ok'] = True

    if not args.no_wait:
        alive, reason = wait_until_ready(workspace, port, timeout=args.wait)
        state['alive'] = alive
        state['reason'] = reason
        if not alive:
            state['hint'] = f'check {LOG_FILE} via dev_logs.py'

    print(json.dumps(state, ensure_ascii=False))


if __name__ == '__main__':
    cli()
