#!/usr/bin/env python3
"""
distill_doc.py — 知识文档抽取流水线，给 skill-creator 喂结构化原料。

用法：
    python scripts/distill_doc.py <pdf_path> [--out parsed/]
                                              [--dpi 200]
                                              [--render-pages "1,3,5"]

输出（默认 ./parsed/）：
    full_text.txt      —— 全文文字（所有页连起来）
    by_page.txt        —— 按页分段的文字
    structure.json     —— 章节结构猜测（基于字号 / 加粗 / 缩进）
    text_blocks.json   —— 按位置的文字块（含 bbox + 字号）
    page_<N>.png       —— 关键页渲染（仅 --render-pages 指定的）
    meta.json          —— 总页数 / 文件大小 / 抽取耗时

设计：
    - 不做 distill（那是 LLM 的活）
    - 只做"抽干净"——文字 / 结构 / 视觉素材
    - skill-creator skill 拿到这些 → 自己 distill
"""
from __future__ import annotations
import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def main() -> int:
    ap = argparse.ArgumentParser(description="知识文档抽取（给 skill-creator 用）")
    ap.add_argument("pdf", help="PDF 路径")
    ap.add_argument("--out", default="parsed", help="输出目录")
    ap.add_argument("--dpi", type=int, default=200, help="渲染 DPI")
    ap.add_argument("--render-pages", default="", help="逗号分隔的需要渲染图的页码，如 1,3,5")
    args = ap.parse_args()

    try:
        import fitz
    except ImportError:
        print(json.dumps({"error": "PyMuPDF 未安装：pip install PyMuPDF"}, ensure_ascii=False), file=sys.stderr)
        return 2

    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        print(json.dumps({"error": f"文件不存在: {pdf_path}"}, ensure_ascii=False), file=sys.stderr)
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    doc = fitz.open(pdf_path)
    n = doc.page_count

    # ---- 全文 + 按页 ----
    full_lines: list[str] = []
    by_page_lines: list[str] = []
    text_blocks: list[dict] = []
    structure_candidates: list[dict] = []  # 标题候选

    for i in range(n):
        page = doc.load_page(i)
        page_num = i + 1

        # 简单全文
        text = page.get_text().strip()
        full_lines.append(text)
        by_page_lines.append(f"\n========== Page {page_num} ==========\n{text}\n")

        # 详细块（含字号，用于猜章节）
        blocks = page.get_text("dict")["blocks"]
        for b in blocks:
            if b.get("type") != 0:  # 0 = text
                continue
            for line in b.get("lines", []):
                for span in line.get("spans", []):
                    txt = span.get("text", "").strip()
                    if not txt:
                        continue
                    size = round(span.get("size", 0), 1)
                    flags = span.get("flags", 0)  # bold/italic flags
                    bbox = [round(x, 1) for x in span.get("bbox", [])]
                    block_data = {
                        "page": page_num,
                        "text": txt,
                        "size": size,
                        "bold": bool(flags & 2 ** 4),
                        "bbox": bbox,
                    }
                    text_blocks.append(block_data)
                    # 标题启发：字号 > 13 或 加粗 + 长度 < 50
                    if (size > 13 or block_data["bold"]) and 1 < len(txt) < 60:
                        structure_candidates.append({
                            "page": page_num,
                            "text": txt,
                            "size": size,
                            "bold": block_data["bold"],
                        })

    # ---- 渲染指定页的图（关键页通常含表 / 图）----
    rendered: list[int] = []
    if args.render_pages.strip():
        wanted = sorted({int(x.strip()) for x in args.render_pages.split(",") if x.strip()})
        zoom = args.dpi / 72.0
        matrix = fitz.Matrix(zoom, zoom)
        for p_num in wanted:
            if 1 <= p_num <= n:
                page = doc.load_page(p_num - 1)
                pix = page.get_pixmap(matrix=matrix, alpha=False)
                out_png = out_dir / f"page_{p_num}.png"
                pix.save(str(out_png))
                rendered.append(p_num)

    doc.close()

    # ---- 写文件 ----
    full_text = "\n\n".join(full_lines)
    (out_dir / "full_text.txt").write_text(full_text, encoding="utf-8")
    (out_dir / "by_page.txt").write_text("".join(by_page_lines), encoding="utf-8")
    (out_dir / "text_blocks.json").write_text(
        json.dumps(text_blocks, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    # 章节结构（去重 + 排序）
    seen = set()
    unique_titles = []
    for c in structure_candidates:
        key = (c["text"], c["page"])
        if key not in seen:
            seen.add(key)
            unique_titles.append(c)
    (out_dir / "structure.json").write_text(
        json.dumps({"title_candidates": unique_titles[:200]}, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    # 总览
    total_chars = sum(len(t) for t in full_lines)
    summary = {
        "source": str(pdf_path),
        "pages": n,
        "total_chars": total_chars,
        "text_blocks": len(text_blocks),
        "title_candidates": len(unique_titles),
        "rendered_pages": rendered,
        "out_dir": str(out_dir),
        "elapsed_s": round(time.time() - t0, 2),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    (out_dir / "meta.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
