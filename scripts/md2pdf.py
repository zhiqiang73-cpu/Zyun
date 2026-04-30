#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
md2pdf.py — Markdown → PDF（高质量，含中文 + 数学 + 表格）

策略:
  1) 先把 markdown 转成漂亮的 HTML（自带样式 + 目录 + 页眉页脚）
  2) 用 Playwright (Chromium) 把 HTML 打印成 PDF
     - 已经装好的话直接用; 没装则降级到 reportlab（仅 ASCII 安全，复杂页面效果差）

依赖:
  pip install markdown
  pip install playwright && python -m playwright install chromium
  （没有 playwright 时会用 reportlab 兜底，已包含在 reportlab 里）

使用:
    python md2pdf.py --md report.md --out report.pdf
    python md2pdf.py --md - --out report.pdf < input.md
    python md2pdf.py --html report.html --out report.pdf  # 直接 HTML→PDF
    python md2pdf.py --md report.md --out report.pdf --title "工艺方案" --no-toc
    python md2pdf.py --md report.md --out report.pdf --theme dark
    python md2pdf.py --list-themes
"""

import sys
import os
import io
import argparse
import asyncio
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

THEMES = {
    'light': {
        'bg': '#ffffff', 'fg': '#1a1f2c', 'muted': '#6b7380',
        'accent': '#5b8def', 'code_bg': '#f6f8fa', 'border': '#e6e8ec',
    },
    'minimal': {
        'bg': '#ffffff', 'fg': '#222222', 'muted': '#888888',
        'accent': '#000000', 'code_bg': '#f5f5f5', 'border': '#dddddd',
    },
    'tech': {
        'bg': '#0b0e14', 'fg': '#e6e9ef', 'muted': '#8b96a8',
        'accent': '#4fc3f7', 'code_bg': '#161b24', 'border': '#2a2e38',
    },
    'warm': {
        'bg': '#fdf6ec', 'fg': '#3a2a1f', 'muted': '#8b7765',
        'accent': '#c26e4a', 'code_bg': '#f6ebd9', 'border': '#e6d8c2',
    },
}


def render_html(md_text, *, title=None, theme_name='light', toc=True):
    try:
        import markdown
    except ImportError:
        print("[md2pdf] ERROR: pip install markdown", file=sys.stderr)
        sys.exit(2)

    extensions = ['tables', 'fenced_code', 'codehilite', 'attr_list', 'def_list']
    if toc:
        extensions.append('toc')
    md = markdown.Markdown(
        extensions=extensions,
        extension_configs={'codehilite': {'guess_lang': False, 'noclasses': True}}
    )
    body_html = md.convert(md_text)

    theme = THEMES.get(theme_name, THEMES['light'])
    if not title:
        # 尝试从 markdown 第一行 H1 抽
        for line in md_text.splitlines():
            line = line.strip()
            if line.startswith('# '):
                title = line[2:].strip()
                break
            if line:
                break
    title = title or '文档'

    css = f"""
    @page {{
      size: A4;
      margin: 22mm 18mm 24mm 18mm;
      @bottom-right {{ content: counter(page) '/' counter(pages); font-size: 9pt; color: {theme['muted']}; }}
      @bottom-left {{ content: '{title}'; font-size: 9pt; color: {theme['muted']}; }}
    }}
    * {{ box-sizing: border-box; }}
    body {{
      font-family: 'Microsoft YaHei', 'PingFang SC', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
      font-size: 11pt; line-height: 1.7;
      color: {theme['fg']}; background: {theme['bg']};
      margin: 0; padding: 0;
    }}
    h1, h2, h3, h4 {{
      color: {theme['fg']}; font-weight: 700;
      page-break-after: avoid; line-height: 1.3;
    }}
    h1 {{ font-size: 22pt; border-bottom: 2px solid {theme['accent']}; padding-bottom: .3em; margin: 1.4em 0 .6em; }}
    h2 {{ font-size: 16pt; margin: 1.2em 0 .4em; }}
    h3 {{ font-size: 13pt; margin: 1em 0 .3em; }}
    p  {{ margin: .5em 0 .8em; orphans: 3; widows: 3; }}
    a  {{ color: {theme['accent']}; text-decoration: none; border-bottom: 1px dotted {theme['accent']}; }}
    blockquote {{
      margin: .8em 0; padding: .5em 1em;
      border-left: 4px solid {theme['accent']};
      color: {theme['muted']};
      background: {theme['code_bg']};
    }}
    code {{ font-family: 'Consolas', 'Courier New', monospace; font-size: 10pt;
            background: {theme['code_bg']}; padding: .1em .35em; border-radius: 3px; }}
    pre {{ background: {theme['code_bg']}; padding: .8em 1em; border-radius: 6px;
           overflow-x: auto; font-size: 9.5pt; line-height: 1.45;
           border: 1px solid {theme['border']}; page-break-inside: avoid; }}
    pre code {{ background: transparent; padding: 0; }}
    table {{ border-collapse: collapse; width: 100%; margin: 1em 0;
             page-break-inside: avoid; font-size: 10pt; }}
    th, td {{ border: 1px solid {theme['border']}; padding: 6px 10px; text-align: left; vertical-align: top; }}
    th {{ background: {theme['accent']}; color: #fff; font-weight: 600; }}
    tr:nth-child(even) td {{ background: {theme['code_bg']}; }}
    img {{ max-width: 100%; height: auto; }}
    ul, ol {{ margin: .5em 0 .8em; padding-left: 1.6em; }}
    li {{ margin: .2em 0; }}
    .doc-title {{
      font-size: 28pt; font-weight: 800; text-align: center;
      margin: .8em 0 .2em; color: {theme['fg']};
    }}
    .doc-subtitle {{
      text-align: center; color: {theme['muted']};
      font-size: 12pt; margin-bottom: 2em;
    }}
    hr {{ border: 0; border-top: 1px solid {theme['border']}; margin: 1.5em 0; }}
    .toc {{
      border: 1px solid {theme['border']}; padding: 1em 1.4em;
      background: {theme['code_bg']}; border-radius: 6px;
      margin: 1.5em 0; page-break-inside: avoid;
    }}
    .toc ul {{ list-style: none; padding-left: 1em; }}
    .toc > ul {{ padding-left: 0; }}
    .toc a {{ border: none; }}
    """

    toc_html = md.toc if toc and getattr(md, 'toc', '').strip() else ''

    html = f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>{title}</title>
  <style>{css}</style>
</head>
<body>
  <div class="doc-title">{title}</div>
  {toc_html}
  {body_html}
</body>
</html>"""
    return html


async def html_to_pdf_playwright(html_text, out_path, *, title='Manuscopy'):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        try:
            page = await browser.new_page()
            await page.set_content(html_text, wait_until='networkidle')
            await page.emulate_media(media='print')
            await page.pdf(
                path=out_path,
                format='A4',
                margin={'top': '22mm', 'bottom': '24mm', 'left': '18mm', 'right': '18mm'},
                print_background=True,
                display_header_footer=False,
                prefer_css_page_size=True,
            )
        finally:
            await browser.close()


def html_to_pdf_reportlab_fallback(html_text, out_path):
    """Best-effort fallback when playwright unavailable."""
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
        from reportlab.lib.units import cm
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from html.parser import HTMLParser
    except ImportError:
        print("[md2pdf] ERROR: neither playwright nor reportlab available.", file=sys.stderr)
        sys.exit(2)

    # 注册中文字体（找系统 YaHei；找不到也 OK，会用默认字体但中文可能渲染成方块）
    cn_font_name = 'Helvetica'
    for path in [
        r'C:\Windows\Fonts\msyh.ttc',
        r'C:\Windows\Fonts\msyh.ttf',
        r'C:\Windows\Fonts\simhei.ttf',
    ]:
        if os.path.exists(path):
            try:
                pdfmetrics.registerFont(TTFont('YaHei', path))
                cn_font_name = 'YaHei'
                break
            except Exception:
                continue

    class TextExtractor(HTMLParser):
        def __init__(self):
            super().__init__()
            self.parts = []
            self.skip_depth = 0
        def handle_starttag(self, tag, attrs):
            if tag in ('script', 'style'):
                self.skip_depth += 1
            elif tag in ('p', 'h1', 'h2', 'h3', 'h4', 'li', 'br', 'tr', 'div'):
                self.parts.append('\n')
        def handle_endtag(self, tag):
            if tag in ('script', 'style'):
                self.skip_depth = max(0, self.skip_depth - 1)
        def handle_data(self, data):
            if self.skip_depth == 0:
                self.parts.append(data)

    parser = TextExtractor()
    parser.feed(html_text)
    text = ''.join(parser.parts)

    doc = SimpleDocTemplate(out_path, pagesize=A4, leftMargin=2*cm, rightMargin=2*cm,
                            topMargin=2*cm, bottomMargin=2*cm)
    style = ParagraphStyle('Body', fontName=cn_font_name, fontSize=10.5, leading=15)
    flow = []
    for line in text.split('\n'):
        line = line.strip()
        if not line:
            flow.append(Spacer(1, 6))
        else:
            # primitive: escape XML-special chars
            safe = line.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            flow.append(Paragraph(safe, style))
    doc.build(flow)


def cli():
    ap = argparse.ArgumentParser(description="Markdown → PDF (chromium-grade)")
    ap.add_argument('--md', help="Markdown 文件 (- 表示 stdin)")
    ap.add_argument('--html', help="跳过 markdown 直接渲 HTML 文件")
    ap.add_argument('--out', default='document.pdf', help="输出 PDF 路径")
    ap.add_argument('--title')
    ap.add_argument('--theme', default='light')
    ap.add_argument('--no-toc', action='store_true', help="不生成 ToC")
    ap.add_argument('--save-html', help="同时把生成的 HTML 落盘到这里（debug 用）")
    ap.add_argument('--list-themes', action='store_true')
    args = ap.parse_args()

    if args.list_themes:
        print('Themes:', ', '.join(THEMES.keys()))
        return

    if args.html:
        with open(args.html, 'r', encoding='utf-8') as f:
            html_text = f.read()
    elif args.md:
        if args.md == '-':
            md_text = sys.stdin.read()
        else:
            with open(args.md, 'r', encoding='utf-8') as f:
                md_text = f.read()
        html_text = render_html(md_text, title=args.title,
                                 theme_name=args.theme, toc=not args.no_toc)
    else:
        ap.error("provide --md FILE or --html FILE")

    if args.save_html:
        Path(args.save_html).parent.mkdir(parents=True, exist_ok=True)
        with open(args.save_html, 'w', encoding='utf-8') as f:
            f.write(html_text)
        print(f"  HTML saved: {args.save_html}", file=sys.stderr)

    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Try playwright first
    try:
        asyncio.run(html_to_pdf_playwright(html_text, str(out_path), title=args.title or 'Document'))
        engine = 'playwright/chromium'
    except Exception as e:
        print(f"[md2pdf] playwright failed ({e}), falling back to reportlab (lower quality)", file=sys.stderr)
        try:
            html_to_pdf_reportlab_fallback(html_text, str(out_path))
            engine = 'reportlab (fallback)'
        except Exception as e2:
            print(f"[md2pdf] ERROR: both engines failed. Detail: {e2}", file=sys.stderr)
            sys.exit(2)

    size = out_path.stat().st_size
    print(f"OK: {out_path} ({size/1024:.1f} KB, engine={engine})")


if __name__ == '__main__':
    cli()
