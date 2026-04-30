#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_html.py — 生成"现代风"独立 HTML 网页（Tailwind CDN + 暗黑/亮色主题）

设计目标:
  - 一个 HTML 文件，浏览器双击就开
  - Tailwind CSS 已通过 CDN 加载（agent 不需要写 Tailwind 配置）
  - 包含响应式 + dark/light 主题切换 + 平滑滚动
  - 默认放大字号、足量留白、清晰的层级（避免"AI 美学"）

使用:
    # 从 JSON spec 出页面（推荐，最快）
    python build_html.py --spec page.json --out index.html

    # 从 markdown 出"内容页"
    python build_html.py --md article.md --out article.html --title "..."

    # 仅输出空模板（让 agent 在里面继续编辑）
    python build_html.py --template hero --out shell.html
    python build_html.py --list-templates
    python build_html.py --schema  # JSON spec 模板

JSON spec:
{
  "title": "页面标题",
  "theme": "light|dark|auto",      # 默认 auto
  "accent": "#5b8def",              # 主色调，默认 manuscopy 蓝
  "sections": [
    {"type": "hero", "headline": "...", "tagline": "...", "cta": {"label": "...", "href": "#"}},
    {"type": "features", "title": "...", "items": [{"icon": "📐", "title": "...", "text": "..."}]},
    {"type": "stats", "items": [{"value": "85%", "label": "..."}]},
    {"type": "content", "title": "...", "html": "<p>...</p>"},
    {"type": "cta", "title": "...", "subtitle": "...", "button": {...}},
    {"type": "footer", "text": "..."}
  ]
}
"""

import sys
import os
import io
import json
import html
import argparse
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')


def esc(s):
    return html.escape(str(s), quote=True)


# ---- Section renderers ------------------------------------------------------

def s_hero(s):
    headline = esc(s.get('headline', ''))
    tagline = esc(s.get('tagline', ''))
    cta = s.get('cta')
    cta_html = ''
    if cta:
        label = esc(cta.get('label', '了解更多'))
        href = esc(cta.get('href', '#'))
        cta_html = f'''
        <a href="{href}" class="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-[var(--accent)] text-white font-semibold shadow-lg hover:opacity-90 transition">
          {label}
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
        </a>'''
    return f'''
    <section class="min-h-[80vh] flex items-center justify-center px-6 py-24 bg-gradient-to-br from-[var(--bg)] to-[var(--surface)]">
      <div class="max-w-4xl mx-auto text-center space-y-6">
        <h1 class="text-5xl md:text-7xl font-bold leading-tight tracking-tight text-[var(--fg)]">{headline}</h1>
        <p class="text-lg md:text-xl text-[var(--muted)] max-w-2xl mx-auto">{tagline}</p>
        {cta_html}
      </div>
    </section>'''


def s_features(s):
    title = esc(s.get('title', ''))
    items = s.get('items', [])
    cards = ''
    for it in items:
        icon = it.get('icon', '✦')
        cards += f'''
        <div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 space-y-3 hover:border-[var(--accent)] transition">
          <div class="text-3xl">{esc(icon)}</div>
          <h3 class="text-lg font-semibold text-[var(--fg)]">{esc(it.get('title', ''))}</h3>
          <p class="text-sm text-[var(--muted)] leading-relaxed">{esc(it.get('text', ''))}</p>
        </div>'''
    return f'''
    <section class="px-6 py-20">
      <div class="max-w-6xl mx-auto space-y-10">
        <h2 class="text-3xl md:text-4xl font-bold text-center text-[var(--fg)]">{title}</h2>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-{min(3, max(1, len(items)))} gap-6">{cards}</div>
      </div>
    </section>'''


def s_stats(s):
    items = s.get('items', [])
    cards = ''
    for it in items:
        cards += f'''
        <div class="text-center space-y-1">
          <div class="text-5xl md:text-6xl font-bold text-[var(--accent)] tracking-tight">{esc(it.get('value', ''))}</div>
          <div class="text-sm text-[var(--muted)]">{esc(it.get('label', ''))}</div>
        </div>'''
    return f'''
    <section class="px-6 py-16 bg-[var(--surface)]">
      <div class="max-w-6xl mx-auto grid grid-cols-2 md:grid-cols-{min(4, max(1, len(items)))} gap-8">{cards}</div>
    </section>'''


def s_content(s):
    title = esc(s.get('title', ''))
    body = s.get('html', '')  # raw HTML, NOT escaped
    return f'''
    <section class="px-6 py-20">
      <div class="max-w-3xl mx-auto space-y-6">
        {f'<h2 class="text-3xl font-bold text-[var(--fg)]">{title}</h2>' if title else ''}
        <div class="prose prose-lg dark:prose-invert max-w-none text-[var(--fg)]">{body}</div>
      </div>
    </section>'''


def s_cta(s):
    title = esc(s.get('title', ''))
    sub = esc(s.get('subtitle', ''))
    btn = s.get('button')
    btn_html = ''
    if btn:
        btn_html = f'''
        <a href="{esc(btn.get('href', '#'))}" class="inline-flex items-center px-8 py-4 rounded-lg bg-white text-[var(--accent)] font-bold text-lg shadow-xl hover:scale-105 transition">
          {esc(btn.get('label', '开始'))}
        </a>'''
    return f'''
    <section class="px-6 py-24 bg-[var(--accent)] text-white">
      <div class="max-w-3xl mx-auto text-center space-y-6">
        <h2 class="text-4xl md:text-5xl font-bold">{title}</h2>
        <p class="text-lg opacity-90">{sub}</p>
        {btn_html}
      </div>
    </section>'''


def s_footer(s):
    text = esc(s.get('text', ''))
    return f'''
    <footer class="px-6 py-10 text-center text-sm text-[var(--muted)] border-t border-[var(--border)]">
      {text}
    </footer>'''


SECTION_RENDERERS = {
    'hero': s_hero,
    'features': s_features,
    'stats': s_stats,
    'content': s_content,
    'cta': s_cta,
    'footer': s_footer,
}


# ---- Templates --------------------------------------------------------------

def template_hero():
    return {
        "title": "你的标题",
        "theme": "auto",
        "accent": "#5b8def",
        "sections": [
            {"type": "hero", "headline": "重塑工艺", "tagline": "AI 让 CNC 编程从小时变成分钟",
             "cta": {"label": "立刻开始", "href": "#features"}},
            {"type": "features", "title": "核心能力", "items": [
                {"icon": "📐", "title": "PDF 识图", "text": "工程图自动转 G-code，单图 3 分钟"},
                {"icon": "⚡", "title": "工艺规则库", "text": "5 大原则 + 7 案例库，自动匹配方案"},
                {"icon": "🛡️", "title": "Critic 兜底", "text": "每个 NC 程序都通过质检清单审核"},
            ]},
            {"type": "stats", "items": [
                {"value": "100+", "label": "已沉淀经验"},
                {"value": "85%", "label": "首次成功率"},
                {"value": "12x", "label": "效率提升"},
            ]},
            {"type": "footer", "text": "Manuscopy · Manus 风格的工艺 AI"},
        ]
    }


def template_doc():
    return {
        "title": "文档",
        "theme": "light",
        "sections": [
            {"type": "content", "title": "标题",
             "html": "<p>把 markdown 转成 HTML 后塞这里。</p>"},
        ]
    }


TEMPLATES = {'hero': template_hero, 'doc': template_doc}


def build(spec):
    title = esc(spec.get('title', '页面'))
    theme = spec.get('theme', 'auto')  # light / dark / auto
    accent = spec.get('accent', '#5b8def')

    # 主题变量
    light_vars = '''
      --bg: #ffffff;
      --surface: #f7f8fa;
      --fg: #1a1f2c;
      --muted: #6b7380;
      --border: #e6e8ec;
    '''
    dark_vars = '''
      --bg: #0b0e14;
      --surface: #161b24;
      --fg: #e6e9ef;
      --muted: #8b96a8;
      --border: #2a2e38;
    '''
    if theme == 'dark':
        theme_css = f':root {{ --accent: {accent}; {dark_vars} }}'
    elif theme == 'light':
        theme_css = f':root {{ --accent: {accent}; {light_vars} }}'
    else:  # auto
        theme_css = f''':root {{ --accent: {accent}; {light_vars} }}
        @media (prefers-color-scheme: dark) {{ :root {{ {dark_vars} }} }}'''

    # Sections
    body_html = ''
    for s in spec.get('sections', []):
        t = s.get('type', '')
        renderer = SECTION_RENDERERS.get(t)
        if not renderer:
            print(f"[build_html] WARN: unknown section type '{t}'", file=sys.stderr)
            continue
        body_html += renderer(s)

    # Final shell
    return f'''<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    {theme_css}
    body {{
      font-family: 'Microsoft YaHei', 'PingFang SC', -apple-system, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      scroll-behavior: smooth;
    }}
    .prose h2, .prose h3 {{ color: var(--fg); }}
    .prose a {{ color: var(--accent); }}
    .prose code {{ background: var(--surface); padding: 0.1em 0.3em; border-radius: 3px; }}
    .prose blockquote {{ border-left: 4px solid var(--accent); color: var(--muted); }}
    .prose pre {{ background: var(--surface); border: 1px solid var(--border); }}
    .prose table th {{ background: var(--accent); color: #fff; }}
  </style>
</head>
<body>
  {body_html}
</body>
</html>'''


def cli():
    ap = argparse.ArgumentParser(description="JSON spec → 现代风独立 HTML 页面")
    ap.add_argument('--spec', help="JSON spec 文件")
    ap.add_argument('--md', help="Markdown 文件（生成单一 content 区块的 HTML）")
    ap.add_argument('--out', default='index.html')
    ap.add_argument('--template', help="预设模板（不传 spec/md 时用）")
    ap.add_argument('--title')
    ap.add_argument('--theme', default=None)
    ap.add_argument('--accent', default=None)
    ap.add_argument('--list-templates', action='store_true')
    ap.add_argument('--schema', action='store_true')
    args = ap.parse_args()

    if args.list_templates:
        print('Templates:', ', '.join(TEMPLATES.keys()))
        return
    if args.schema:
        print(json.dumps(template_hero(), ensure_ascii=False, indent=2))
        return

    if args.spec:
        with open(args.spec, 'r', encoding='utf-8') as f:
            spec = json.load(f)
    elif args.md:
        try:
            import markdown
        except ImportError:
            print("[build_html] ERROR: pip install markdown", file=sys.stderr)
            sys.exit(2)
        with open(args.md, 'r', encoding='utf-8') as f:
            md_text = f.read()
        body = markdown.markdown(md_text, extensions=['tables', 'fenced_code', 'attr_list'])
        spec = {
            "title": args.title or "Document",
            "theme": args.theme or 'light',
            "sections": [{"type": "content", "title": args.title or '', "html": body}],
        }
    elif args.template:
        if args.template not in TEMPLATES:
            print(f"[build_html] ERROR: unknown template '{args.template}'. Try --list-templates", file=sys.stderr)
            sys.exit(2)
        spec = TEMPLATES[args.template]()
    else:
        ap.error("provide --spec, --md, or --template")

    if args.title:
        spec['title'] = args.title
    if args.theme:
        spec['theme'] = args.theme
    if args.accent:
        spec['accent'] = args.accent

    html_text = build(spec)
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html_text)
    size = out_path.stat().st_size
    print(f"OK: {out_path} ({size/1024:.1f} KB, {len(spec.get('sections', []))} sections)")


if __name__ == '__main__':
    cli()
