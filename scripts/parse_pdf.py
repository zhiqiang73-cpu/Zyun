#!/usr/bin/env python3
"""
parse_pdf.py — 把 PDF 工程图拆成 Claude 能 Read 的资源。

用法：
    python3 scripts/parse_pdf.py uploads/part.pdf [--out parsed] [--dpi 300]

输出（默认 ./parsed/）：
    page_1.png        每页高分辨率渲染（DPI 300，约 2400×3000）
    page_2.png        ...
    text.json         每个文字块：{ page, bbox, text, font_size }
    meta.json         { pages, page_sizes_mm, source_file, generated_at }

依赖：
    pip install PyMuPDF
"""
from __future__ import annotations
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="Parse PDF for engineering drawing analysis")
    ap.add_argument("pdf", help="Path to input PDF")
    ap.add_argument("--out", default="parsed", help="Output dir (default: parsed)")
    ap.add_argument("--dpi", type=int, default=300, help="Render DPI for page images (default: 300)")
    ap.add_argument("--pages", default="", help="Comma-separated 1-based page list (default: all)")
    args = ap.parse_args()

    try:
        import fitz  # PyMuPDF
    except ImportError:
        print(
            "[error] PyMuPDF not installed. Run:  pip install PyMuPDF",
            file=sys.stderr,
        )
        return 2

    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        print(f"[error] PDF not found: {pdf_path}", file=sys.stderr)
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    total_pages = doc.page_count

    # Decide which pages to process
    if args.pages.strip():
        wanted = sorted({int(x.strip()) for x in args.pages.split(",") if x.strip()})
        wanted = [p for p in wanted if 1 <= p <= total_pages]
    else:
        wanted = list(range(1, total_pages + 1))

    text_blocks: list[dict] = []
    page_sizes_mm: list[list[float]] = []
    zoom = args.dpi / 72.0  # PDF user-space units are 1/72 inch
    matrix = fitz.Matrix(zoom, zoom)

    for page_index_0 in range(total_pages):
        page = doc.load_page(page_index_0)
        page_num = page_index_0 + 1

        # Page size in mm (1pt = 1/72 inch = 25.4/72 mm)
        rect = page.rect
        width_mm = rect.width * 25.4 / 72
        height_mm = rect.height * 25.4 / 72
        page_sizes_mm.append([round(width_mm, 2), round(height_mm, 2)])

        # Extract text blocks with positions
        for block in page.get_text("blocks"):
            # block: (x0, y0, x1, y1, text, block_no, block_type)
            x0, y0, x1, y1, text, *_ = block
            txt = (text or "").strip()
            if not txt:
                continue
            text_blocks.append({
                "page": page_num,
                "bbox": [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)],
                "text": txt,
            })

        # Render image only for wanted pages (saves disk)
        if page_num in wanted:
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            out_png = out_dir / f"page_{page_num}.png"
            pix.save(str(out_png))
            print(f"[ok] page {page_num} → {out_png}  ({pix.width}×{pix.height})")

    # Write text.json
    text_json = out_dir / "text.json"
    with text_json.open("w", encoding="utf-8") as f:
        json.dump(text_blocks, f, ensure_ascii=False, indent=2)
    print(f"[ok] text blocks ({len(text_blocks)}) → {text_json}")

    # Write meta.json
    meta = {
        "source_file": str(pdf_path),
        "pages_total": total_pages,
        "pages_rendered": wanted,
        "page_sizes_mm": page_sizes_mm,
        "render_dpi": args.dpi,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    meta_json = out_dir / "meta.json"
    with meta_json.open("w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"[ok] meta → {meta_json}")

    doc.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
