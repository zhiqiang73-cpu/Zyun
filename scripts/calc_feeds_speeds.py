#!/usr/bin/env python3
"""
calc_feeds_speeds.py — 切削参数查表+计算。

用法：
    python scripts/calc_feeds_speeds.py \
        --material HT150 \
        --tool carbide_endmill \
        --diameter 10 \
        --teeth 4 \
        --operation slot_milling \
        [--strategy standard]   # conservative / standard / aggressive

输出（JSON 到 stdout）：
{
  "input": {...},
  "lookup": { "Vc": ..., "fz": ..., "ap_x_D": ..., "ae_x_D": ... },
  "computed": {
    "Vc_m_per_min": 80,
    "S_rpm": 2546,
    "fz_mm": 0.1,
    "F_mm_per_min": 1018,
    "ap_mm": 4,
    "ae_mm": 10,
    "MRR_mm3_per_min": 40720
  },
  "warnings": [...],
  "material_notes": [...]
}

设计原则：
1. 查表为主，公式为辅（S = Vc·1000/(πD)）
2. 默认 standard（中位数）；保守取低位，激进取高位
3. 找不到匹配时退化：tool/operation 模糊匹配 → 返回告警
4. 所有数据来自 knowledge/{materials,cutting_data}.json，不从外部网络查
"""
from __future__ import annotations
import argparse
import json
import math
import sys
from pathlib import Path

# 强制 stdout 为 UTF-8，避免 Windows cmd 默认 GBK 把中文字段输出成乱码
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
KNOWLEDGE_DIR = ROOT / "knowledge"


def load_json(name: str) -> dict:
    p = KNOWLEDGE_DIR / name
    if not p.exists():
        # 尝试 workspace 内（agent 当前工作目录）
        alt = Path.cwd() / "knowledge" / name
        if alt.exists():
            p = alt
        else:
            raise FileNotFoundError(f"找不到 {name}（已查 {p} 与 {alt}）")
    return json.loads(p.read_text(encoding="utf-8"))


def pick(values: list, strategy: str) -> float:
    """按策略从 [low, mid, high] 三元组里取一个值。"""
    if not isinstance(values, list) or len(values) < 1:
        raise ValueError(f"参数三元组无效: {values}")
    if len(values) == 1:
        return float(values[0])
    if len(values) == 2:
        low, high = float(values[0]), float(values[1])
        mid = (low + high) / 2
    else:
        low, mid, high = float(values[0]), float(values[1]), float(values[2])
    if strategy == "conservative":
        return low
    if strategy == "aggressive":
        return high
    return mid  # default standard


def resolve_table(cutting_data: dict, material: str, tool: str, operation: str):
    """
    从切削表里找参数。支持 _inherit_from + _scale 的继承规则。
    返回 (params_dict, scale_factor, parent_material_or_None)
    """
    if material not in cutting_data:
        raise KeyError(f"材料 {material} 不在切削数据库")

    mat_block = cutting_data[material]

    # 处理继承
    inherit = mat_block.get("_inherit_from")
    scale = mat_block.get("_scale", 1.0)

    if inherit:
        parent = cutting_data[inherit]
        # 先看本材料有没有覆盖；没有就用 parent
        if tool not in mat_block or operation not in mat_block.get(tool, {}):
            parent_block = parent.get(tool)
            if parent_block and operation in parent_block:
                return parent_block[operation], scale, inherit

    if tool not in mat_block:
        # 模糊匹配建议
        avail = [k for k in mat_block.keys() if not k.startswith("_")]
        raise KeyError(f"刀具类型 {tool} 不在 {material} 数据中。可选: {avail}")

    tool_block = mat_block[tool]
    if operation not in tool_block:
        avail = list(tool_block.keys())
        raise KeyError(f"工序 {operation} 不在 {material}/{tool} 数据中。可选: {avail}")

    return tool_block[operation], 1.0, None


def main() -> int:
    ap = argparse.ArgumentParser(description="切削参数查表与计算 + 数据库发现")
    ap.add_argument("--material", help="材料代号，如 HT150 / 6061-T6 / 45 / 304")
    ap.add_argument("--tool", help="刀具类型，如 carbide_endmill / carbide_drill / tap / reamer_machine")
    ap.add_argument("--diameter", type=float, help="刀具直径 mm")
    ap.add_argument("--teeth", type=int, default=0, help="齿数（多刃刀具必填，默认 0；钻头/丝锥忽略）")
    ap.add_argument("--operation", help="工序，如 rough_milling / slot_milling / drilling / threading / reaming / boring")
    ap.add_argument("--strategy", choices=["conservative", "standard", "aggressive"], default="standard")
    ap.add_argument("--pitch", type=float, default=0, help="螺距 mm（仅 threading 工序需要）")
    # 发现命令
    ap.add_argument("--list-materials", action="store_true", help="列出数据库里所有材料")
    ap.add_argument("--list-tools", action="store_true", help="列出某材料下所有可用刀具（需配 --material）")
    ap.add_argument("--list-operations", action="store_true", help="列出某材料+刀具下所有工序（需配 --material 和 --tool）")
    args = ap.parse_args()

    # 加载数据库（任何模式都要）
    try:
        materials = load_json("materials.json")
        cutting_data = load_json("cutting_data.json")
    except FileNotFoundError as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        return 2

    # ---- 发现模式：不要求完整参数 ----
    if args.list_materials:
        out = {
            "materials_in_db": list(cutting_data.keys()),
            "details": {k: {"name": materials.get(k, {}).get("name"), "category": materials.get(k, {}).get("category")} for k in cutting_data.keys() if not k.startswith("_")},
            "hint": "数据库外的材料按 skills/machining-handbook.md 第 5 节'材料外推'套用 scale。",
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    if args.list_tools:
        if not args.material:
            print(json.dumps({"error": "--list-tools 需要配 --material"}, ensure_ascii=False), file=sys.stderr)
            return 1
        if args.material not in cutting_data:
            print(json.dumps({"error": f"材料 {args.material} 不在数据库", "available": [k for k in cutting_data.keys() if not k.startswith('_')]}, ensure_ascii=False), file=sys.stderr)
            return 1
        block = cutting_data[args.material]
        tools = [k for k in block.keys() if not k.startswith("_")]
        # 如果是继承材料，也合并父表的刀具
        inherit = block.get("_inherit_from")
        if inherit and inherit in cutting_data:
            parent_tools = [k for k in cutting_data[inherit].keys() if not k.startswith("_")]
            tools = sorted(set(tools) | set(parent_tools))
        out = {"material": args.material, "tools": tools}
        if inherit:
            out["inherit_from"] = inherit
            out["scale"] = block.get("_scale", 1.0)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    if args.list_operations:
        if not args.material or not args.tool:
            print(json.dumps({"error": "--list-operations 需要配 --material 和 --tool"}, ensure_ascii=False), file=sys.stderr)
            return 1
        block = cutting_data.get(args.material, {})
        tool_block = block.get(args.tool, {})
        ops = [k for k in tool_block.keys() if not k.startswith("_")]
        # 检查继承
        inherit = block.get("_inherit_from")
        if inherit and not ops:
            parent_ops = list((cutting_data.get(inherit, {}).get(args.tool, {})).keys())
            ops = [o for o in parent_ops if not o.startswith("_")]
        out = {"material": args.material, "tool": args.tool, "operations": ops}
        if not ops:
            out["error"] = f"{args.material}/{args.tool} 在数据库中没有数据"
            avail_tools = [k for k in block.keys() if not k.startswith("_")]
            out["available_tools_for_material"] = avail_tools
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    # ---- 计算模式：参数必填 ----
    missing = [n for n, v in [("--material", args.material), ("--tool", args.tool), ("--diameter", args.diameter), ("--operation", args.operation)] if not v]
    if missing:
        print(json.dumps({
            "error": f"计算模式缺少参数: {', '.join(missing)}",
            "hint": "用 --list-materials / --list-tools / --list-operations 先发现数据库内容；或参考 skills/machining-handbook.md",
        }, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1

    out: dict = {
        "input": {
            "material": args.material,
            "tool": args.tool,
            "diameter_mm": args.diameter,
            "teeth": args.teeth,
            "operation": args.operation,
            "strategy": args.strategy,
        },
        "warnings": [],
    }
    # materials/cutting_data 已在上面加载，跳过重新加载

    # 材料注释（agent 看了能注意工艺细节）
    if args.material in materials:
        mat = materials[args.material]
        out["material_notes"] = {
            "name": mat.get("name"),
            "machinability_rating": mat.get("machinability_rating"),
            "preferred_coolant": mat.get("preferred_coolant"),
            "key_warnings": mat.get("key_warnings", []),
            "tool_recommendation": mat.get("cutting_tool_recommendation", []),
        }
    else:
        out["warnings"].append(f"材料 {args.material} 不在 materials.json 里，建议先补充")

    # 查切削数据表
    try:
        params, scale, inherit = resolve_table(cutting_data, args.material, args.tool, args.operation)
    except KeyError as e:
        print(json.dumps({"error": str(e), **out}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1

    out["lookup"] = {"raw": params, "scale": scale, "inherited_from": inherit}

    # 取值（应用 strategy 和 scale）
    Vc_raw = pick(params["Vc"], args.strategy)
    Vc = Vc_raw * scale

    D = args.diameter
    if D <= 0:
        print(json.dumps({"error": "diameter 必须 > 0"}, ensure_ascii=False), file=sys.stderr)
        return 1

    # S = Vc * 1000 / (π * D)
    S = Vc * 1000.0 / (math.pi * D)

    computed = {
        "Vc_m_per_min": round(Vc, 1),
        "S_rpm": round(S),
    }

    # 进给率：多刃 vs 单刃工序
    is_drill_or_ream = args.operation in ("drilling", "deep_drilling", "reaming", "boring")
    is_thread = args.operation == "threading"

    if is_thread:
        if args.pitch <= 0:
            out["warnings"].append("threading 工序需要 --pitch（螺距）才能算 F；当前未提供")
            computed["F_mm_per_min"] = None
        else:
            computed["fr_mm_per_rev"] = args.pitch
            computed["F_mm_per_min"] = round(args.pitch * S, 1)
    elif is_drill_or_ream:
        if "fr" not in params:
            out["warnings"].append(f"{args.tool}/{args.operation} 数据缺 fr 字段")
        else:
            fr = pick(params["fr"], args.strategy) * scale
            computed["fr_mm_per_rev"] = round(fr, 3)
            computed["F_mm_per_min"] = round(fr * S, 1)
    else:
        # 多刃铣削
        if args.teeth <= 0:
            out["warnings"].append("多刃铣削必须 --teeth；当前未提供，F 无法精确计算")
        else:
            fz = pick(params["fz"], args.strategy) * scale
            F = fz * args.teeth * S
            computed["fz_mm_per_tooth"] = round(fz, 3)
            computed["F_mm_per_min"] = round(F, 1)
            computed["teeth"] = args.teeth

    # ap / ae（仅铣削适用）
    if "ap_x_D" in params:
        ap_factor = pick(params["ap_x_D"], args.strategy)
        computed["ap_mm"] = round(ap_factor * D, 2)
    if "ae_x_D" in params:
        ae_factor = pick(params["ae_x_D"], args.strategy)
        computed["ae_mm"] = round(ae_factor * D, 2)

    # MRR (材料去除率)
    ap = computed.get("ap_mm")
    ae = computed.get("ae_mm")
    F = computed.get("F_mm_per_min")
    if ap and ae and F:
        computed["MRR_mm3_per_min"] = round(ap * ae * F)

    out["computed"] = computed

    # 安全检查：超低/超高 RPM 提示
    if S < 100:
        out["warnings"].append(f"S={round(S)} RPM 偏低，确认机床能稳定输出该转速")
    if S > 20000:
        out["warnings"].append(f"S={round(S)} RPM 偏高（>20000），确认机床主轴能力")

    # 提示（可读性 hint）
    if inherit:
        out["warnings"].append(f"参数继承自 {inherit}，已套 scale={scale}")
    if scale != 1.0 and not inherit:
        out["warnings"].append(f"参数已套 scale={scale}")

    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
