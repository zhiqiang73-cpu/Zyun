#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deploy.py — 三种部署目标自动选择，把 workspace 里的 web 项目推上线。

优先级（自动选最先满足的）：
  1) VERCEL_TOKEN 已设 + vercel CLI 可用 / 或 npx vercel  → Vercel
  2) NETLIFY_AUTH_TOKEN 已设 + netlify-cli 可用 / 或 npx netlify  → Netlify
  3) 不能上线 → 打包成 zip 放在 workspace/_dist.zip + 给本地预览指引

使用:
    python scripts/deploy.py                     # 自动选
    python scripts/deploy.py --target vercel     # 强制 vercel
    python scripts/deploy.py --target netlify    # 强制 netlify
    python scripts/deploy.py --target zip        # 强制打包
    python scripts/deploy.py --build             # 部署前先 npm run build
    python scripts/deploy.py --prod              # 生产环境（vercel: --prod；netlify: --prod）

返回 JSON:
    {"ok": true, "target": "vercel", "url": "https://my-app-abc123.vercel.app",
     "command": "npx vercel deploy --prod ..."}
或：
    {"ok": false, "reason": "...", "hint": "..."}
"""

import sys
import os
import io
import json
import shutil
import argparse
import subprocess
import zipfile
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')


def has_cmd(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def detect_project_kind(workspace: Path) -> str:
    """Returns 'next' / 'vite' / 'spa' / 'static' / 'unknown'."""
    pkg = workspace / 'package.json'
    if pkg.exists():
        try:
            obj = json.loads(pkg.read_text(encoding='utf-8'))
            deps = {**obj.get('dependencies', {}), **obj.get('devDependencies', {})}
            if 'next' in deps:
                return 'next'
            if 'vite' in deps:
                return 'vite'
            scripts = obj.get('scripts', {})
            if 'build' in scripts:
                return 'spa'
        except Exception:
            pass
    if (workspace / 'index.html').exists():
        return 'static'
    return 'unknown'


def run(cmd, cwd: Path, env: dict | None = None) -> tuple[int, str, str]:
    """Run command, return (code, stdout, stderr). Always wait."""
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            shell=isinstance(cmd, str),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=600,
        )
        return (proc.returncode, proc.stdout or '', proc.stderr or '')
    except subprocess.TimeoutExpired:
        return (124, '', 'timeout after 600s')
    except Exception as e:
        return (1, '', str(e))


# ---- Targets ----------------------------------------------------------------

def deploy_vercel(workspace: Path, prod: bool) -> dict:
    if not os.environ.get('VERCEL_TOKEN'):
        return {'ok': False, 'reason': 'VERCEL_TOKEN env not set',
                'hint': 'Set VERCEL_TOKEN in your shell or .env, or use --target zip'}

    base = ['npx', '-y', 'vercel'] if not has_cmd('vercel') else ['vercel']
    cmd = base + ['deploy', '--yes', '--token', os.environ['VERCEL_TOKEN']]
    if prod:
        cmd.append('--prod')

    code, out, err = run(cmd, workspace)
    combined = (out + '\n' + err).strip()
    if code != 0:
        return {
            'ok': False, 'target': 'vercel', 'reason': 'vercel CLI failed',
            'detail': combined[-1000:],
        }
    # Vercel CLI prints the deployment URL on stdout, last line is usually the prod URL
    lines = [l.strip() for l in (out + err).splitlines() if l.strip()]
    url = next((l for l in reversed(lines) if l.startswith('https://')), '')
    return {
        'ok': True, 'target': 'vercel', 'url': url,
        'command': ' '.join(c if c != os.environ['VERCEL_TOKEN'] else '<TOKEN>' for c in cmd),
    }


def deploy_netlify(workspace: Path, prod: bool) -> dict:
    token = os.environ.get('NETLIFY_AUTH_TOKEN') or os.environ.get('NETLIFY_TOKEN')
    if not token:
        return {'ok': False, 'reason': 'NETLIFY_AUTH_TOKEN env not set',
                'hint': 'Set NETLIFY_AUTH_TOKEN in your shell or .env, or use --target zip'}

    kind = detect_project_kind(workspace)
    publish_dir: str
    if kind == 'next':
        # Static export support; otherwise use Vercel for SSR
        publish_dir = 'out'
        # Try `npx next export` if .next exists but out does not
    elif kind == 'vite':
        publish_dir = 'dist'
    elif kind == 'spa':
        publish_dir = 'dist'
    elif kind == 'static':
        publish_dir = '.'
    else:
        return {'ok': False, 'reason': 'cannot determine publish dir for this project'}

    if not (workspace / publish_dir).exists() and publish_dir != '.':
        return {
            'ok': False, 'reason': f'publish dir "{publish_dir}" not found',
            'hint': 'Run with --build first to produce build output',
        }

    base = ['npx', '-y', 'netlify-cli'] if not has_cmd('netlify') else ['netlify']
    cmd = base + ['deploy', '--auth', token, '--dir', publish_dir]
    if prod:
        cmd.append('--prod')

    code, out, err = run(cmd, workspace)
    combined = (out + '\n' + err).strip()
    if code != 0:
        return {
            'ok': False, 'target': 'netlify', 'reason': 'netlify CLI failed',
            'detail': combined[-1000:],
        }
    # netlify prints "Website URL: https://..." line
    lines = [l.strip() for l in combined.splitlines() if l.strip()]
    url = ''
    for l in lines:
        if 'https://' in l and ('Website URL' in l or 'Live URL' in l or 'Live Draft URL' in l):
            url = l.split('https://')[-1].split()[0]
            url = 'https://' + url
            break
    if not url:
        # fallback: any https URL in output
        import re
        m = re.search(r'https?://[^\s]+', combined)
        if m:
            url = m.group(0)
    return {
        'ok': True, 'target': 'netlify', 'url': url,
        'command': ' '.join(c if c != token else '<TOKEN>' for c in cmd),
    }


def deploy_zip(workspace: Path) -> dict:
    """Fallback: zip the workspace deliverables (no upload)."""
    ignore = {'.next', 'node_modules', '.git', '.cache', 'parsed', 'uploads',
              'skills', 'scripts', 'knowledge', 'config'}
    out_path = workspace / '_dist.zip'
    if out_path.exists():
        out_path.unlink()
    count = 0
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(workspace):
            # filter dirs in-place
            dirs[:] = [d for d in dirs if d not in ignore and not d.startswith('.')]
            for f in files:
                if f.startswith('.manuscopy_'):
                    continue
                if f == '_dist.zip':
                    continue
                abs_p = Path(root) / f
                rel_p = abs_p.relative_to(workspace)
                try:
                    zf.write(abs_p, str(rel_p).replace('\\', '/'))
                    count += 1
                except Exception:
                    pass
    size_kb = out_path.stat().st_size / 1024
    return {
        'ok': True, 'target': 'zip', 'path': str(out_path), 'files': count,
        'size_kb': round(size_kb, 1),
        'hint': '没有 token 暂不能直接上线。把 _dist.zip 解压上传到任何静态托管（GitHub Pages / Cloudflare Pages / Surge）。',
    }


# ---- Build -----------------------------------------------------------------

def run_build(workspace: Path) -> dict:
    pkg = workspace / 'package.json'
    if not pkg.exists():
        return {'ok': True, 'skipped': 'no package.json'}
    try:
        obj = json.loads(pkg.read_text(encoding='utf-8'))
        if 'build' not in obj.get('scripts', {}):
            return {'ok': True, 'skipped': 'no build script'}
    except Exception:
        return {'ok': True, 'skipped': 'package.json unreadable'}

    code, out, err = run(['npm', 'run', 'build'], workspace)
    if code != 0:
        return {'ok': False, 'reason': 'build failed',
                'tail': (out + err)[-1500:]}
    return {'ok': True, 'tail': (out + err)[-500:]}


# ---- CLI -------------------------------------------------------------------

def cli():
    ap = argparse.ArgumentParser(description='Deploy current workspace web project.')
    ap.add_argument('--target', choices=['auto', 'vercel', 'netlify', 'zip'], default='auto')
    ap.add_argument('--build', action='store_true', help='Run npm run build before deploy')
    ap.add_argument('--prod', action='store_true', help='Production deploy (where supported)')
    args = ap.parse_args()

    workspace = Path('.').resolve()

    # Optional pre-build
    if args.build:
        b = run_build(workspace)
        if not b.get('ok'):
            print(json.dumps({
                'ok': False, 'phase': 'build',
                'reason': b.get('reason'), 'tail': b.get('tail'),
            }, ensure_ascii=False))
            sys.exit(2)

    # Auto-select target
    target = args.target
    if target == 'auto':
        if os.environ.get('VERCEL_TOKEN'):
            target = 'vercel'
        elif os.environ.get('NETLIFY_AUTH_TOKEN') or os.environ.get('NETLIFY_TOKEN'):
            target = 'netlify'
        else:
            target = 'zip'

    if target == 'vercel':
        result = deploy_vercel(workspace, args.prod)
    elif target == 'netlify':
        result = deploy_netlify(workspace, args.prod)
    else:
        result = deploy_zip(workspace)

    print(json.dumps(result, ensure_ascii=False))
    if not result.get('ok'):
        sys.exit(1)


if __name__ == '__main__':
    cli()
