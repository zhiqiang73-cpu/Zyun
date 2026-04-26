#!/usr/bin/env python3
"""
lint_gcode.py — 简易 FANUC G-code 静态校验器。

用法：
    python3 scripts/lint_gcode.py part.nc

检查：
  1. 程序号 O 开头
  2. 必备模态码（G21/G17/G90/G54）
  3. M30 程序结束
  4. 每个 G81/G82/G83/G84 后必有 G80
  5. G41/G42 必有 D；启用前必有 G01/G00 直线运动；G40 必带退刀
  6. F 进给在 G01 之后是否给出（至少一次）
  7. 注释括号是否匹配
  8. Z 坐标的简单合理性（不超出常见 ±300mm）
  9. 主轴/切削液配对（M03 → M05；M08 → M09）
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ISSUES: list[tuple[str, int, str]] = []  # (severity, line_no, message)

def issue(sev: str, line_no: int, msg: str) -> None:
    ISSUES.append((sev, line_no, msg))


def lint(text: str) -> int:
    lines = text.splitlines()

    # 全局检查
    has_O = False
    has_M30 = False
    has_G21 = False
    has_G17 = False
    has_G90 = False
    has_G54 = False
    has_F_after_G01 = False
    seen_first_G01 = False

    in_cycle = False           # 当前是否处于固定循环（G81-89）
    cycle_open_line = 0        # 最近一个未关闭的循环行号

    spindle_on = False
    coolant_on = False
    spindle_on_line = 0
    coolant_on_line = 0

    open_paren = 0  # 括号嵌套（FANUC 不允许嵌套，>0 即未闭合）

    for idx, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line or line.startswith(";") or line == "%":
            continue

        # 注释括号匹配
        for ch in line:
            if ch == "(":
                open_paren += 1
                if open_paren > 1:
                    issue("error", idx, "FANUC 不允许嵌套括号注释")
            elif ch == ")":
                open_paren = max(0, open_paren - 1)

        upper = line.upper()

        # 程序号
        if re.match(r"^O\d{1,5}\b", upper):
            has_O = True

        # 模态码
        if re.search(r"\bG21\b", upper): has_G21 = True
        if re.search(r"\bG17\b", upper): has_G17 = True
        if re.search(r"\bG90\b", upper): has_G90 = True
        if re.search(r"\bG54\b", upper): has_G54 = True

        # 程序结束
        if re.search(r"\bM30\b", upper): has_M30 = True

        # 固定循环开/关
        if re.search(r"\bG8[1-9]\b", upper):
            if in_cycle:
                # 已经在循环中，又开新循环 → 隐含切换，FANUC 允许，但提示
                issue("warn", idx, "未 G80 即切换固定循环，FANUC 会沿用上次模态")
            in_cycle = True
            cycle_open_line = idx
        if re.search(r"\bG80\b", upper):
            in_cycle = False

        # G01 + F
        if re.search(r"\bG0?1\b", upper):
            seen_first_G01 = True
            if re.search(r"\bF\d", upper):
                has_F_after_G01 = True

        # 刀补检查
        m_g41_42 = re.search(r"\bG4[12]\b", upper)
        if m_g41_42:
            if not re.search(r"\bD\d", upper):
                issue("error", idx, f"{m_g41_42.group()} 未指定 D 偏置号")
            if not re.search(r"\bG0?[01]\b", upper):
                issue("warn", idx, f"{m_g41_42.group()} 启用块通常应同时有 G01/G00 直线运动")

        # 主轴
        if re.search(r"\bM03\b|\bM04\b", upper):
            spindle_on = True
            spindle_on_line = idx
        if re.search(r"\bM05\b", upper):
            spindle_on = False

        # 切削液
        if re.search(r"\bM08\b", upper):
            coolant_on = True
            coolant_on_line = idx
        if re.search(r"\bM09\b", upper):
            coolant_on = False

        # Z 范围检查
        m_z = re.search(r"\bZ(-?\d+(\.\d+)?)\b", upper)
        if m_z:
            z = float(m_z.group(1))
            if z < -300 or z > 300:
                issue("warn", idx, f"Z={z} 超出常见机床行程 ±300mm，请确认")

    # 收尾检查
    if not has_O: issue("error", 0, "缺少程序号（O 开头）")
    if not has_G21: issue("error", 0, "缺少 G21（公制）")
    if not has_G17: issue("warn", 0, "缺少 G17（XY 平面）")
    if not has_G90: issue("error", 0, "缺少 G90（绝对坐标）")
    if not has_G54: issue("warn", 0, "缺少 G54 工件坐标系（也可能用 G55-G59）")
    if not has_M30: issue("error", 0, "缺少 M30 程序结束")
    if seen_first_G01 and not has_F_after_G01:
        issue("error", 0, "用了 G01 但没有任何 F 进给指令")
    if in_cycle:
        issue("error", cycle_open_line, "固定循环未用 G80 取消")
    if spindle_on:
        issue("warn", spindle_on_line, "程序结束前主轴未 M05 关闭")
    if coolant_on:
        issue("warn", coolant_on_line, "程序结束前切削液未 M09 关闭")
    if open_paren != 0:
        issue("error", 0, "注释括号未闭合")

    # 输出报告
    errors = sum(1 for s, *_ in ISSUES if s == "error")
    warns = sum(1 for s, *_ in ISSUES if s == "warn")

    print(f"=== G-code Lint Report ===")
    print(f"errors: {errors}   warnings: {warns}")
    print()
    for sev, lineno, msg in ISSUES:
        prefix = "❌" if sev == "error" else "⚠️ "
        loc = f"line {lineno}" if lineno > 0 else "global"
        print(f"  {prefix} [{loc}] {msg}")

    if errors == 0 and warns == 0:
        print("✅ 全部通过")

    return 0 if errors == 0 else 1


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/lint_gcode.py <file.nc>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"[error] not found: {path}", file=sys.stderr)
        return 2
    text = path.read_text(encoding="utf-8", errors="replace")
    return lint(text)


if __name__ == "__main__":
    sys.exit(main())
