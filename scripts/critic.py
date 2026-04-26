#!/usr/bin/env python3
"""
critic.py — 工艺路线 + G-code 独立质检子 agent。

由 Claude 主大脑通过 Bash 调用，输入工艺方案 + G-code 文件 + 用户原始需求，
后端用 DeepSeek-R1（推理强）执行 skills/critic-checklist.md 里的审查清单，
输出结构化 JSON。

用法：
    python scripts/critic.py \
        --requirements "用户原始需求文本" \
        --plan path/to/process_plan.json \
        --gcode path/to/part.nc \
        [--features path/to/features.json] \
        [--lint path/to/lint_output.txt] \
        [--out review.json]

输出 JSON 字段：
    verdict, score, checks{...}, critical_issues[], warnings[], approved_with_notes
"""
from __future__ import annotations
import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
CONFIG_PATH = PROJECT_ROOT / "config" / "helpers.json"
ENV_PATH = PROJECT_ROOT / ".env"
SKILL_PATH = PROJECT_ROOT / "skills" / "critic-checklist.md"


def load_env(path: Path) -> dict:
    env = dict(os.environ)
    if not path.exists():
        return env
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip().strip('"').strip("'")
            if k.strip():
                env[k.strip()] = v  # .env 覆盖系统级
    except Exception:
        pass
    return env


def load_helpers() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def call_llm(base: str, key: str, model: str, system: str, user: str, max_tokens: int = 4096) -> dict:
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.1,
        "stream": False,
    }
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        return {"_http_error": e.code, "_body": e.read().decode("utf-8", "replace")[:500]}
    except Exception as e:
        return {"_error": str(e)}


def safe_read(path: str | None) -> str:
    if not path:
        return ""
    p = Path(path)
    if not p.exists():
        return f"[file not found: {path}]"
    try:
        text = p.read_text(encoding="utf-8")
        return text[:8000]  # 防爆，截断
    except Exception as e:
        return f"[read failed: {e}]"


def main() -> int:
    ap = argparse.ArgumentParser(description="独立质检 critic 子 agent")
    ap.add_argument("--requirements", default="", help="用户原始需求文本")
    ap.add_argument("--plan", default="", help="process_plan.json 文件路径")
    ap.add_argument("--gcode", default="", help="G-code (.nc) 文件路径")
    ap.add_argument("--features", default="", help="识图 features.json（可选）")
    ap.add_argument("--lint", default="", help="lint_gcode.py 输出文本（可选）")
    ap.add_argument("--out", default="", help="结果写入此文件")
    ap.add_argument("--role", default="reason", help="用哪个 helper 角色（默认 reason = DeepSeek-R1）")
    args = ap.parse_args()

    env = load_env(ENV_PATH)
    config = load_helpers()
    cfg = config.get(args.role) or config.get("default")
    if not cfg:
        print(json.dumps({"error": f"helper role {args.role} not configured"}, ensure_ascii=False), file=sys.stderr)
        return 2
    key = env.get(cfg.get("key_env", ""))
    if not key:
        print(json.dumps({"error": f"key {cfg.get('key_env')} not set"}, ensure_ascii=False), file=sys.stderr)
        return 2

    # 加载 critic skill 作 system prompt
    if not SKILL_PATH.exists():
        print(json.dumps({"error": f"skill not found: {SKILL_PATH}"}, ensure_ascii=False), file=sys.stderr)
        return 2
    system_prompt = SKILL_PATH.read_text(encoding="utf-8")

    # 拼 user prompt
    parts = []
    parts.append("## 用户原始需求")
    parts.append(args.requirements or "(未提供)")
    parts.append("")
    if args.features:
        parts.append("## 识图结果（features）")
        parts.append("```json")
        parts.append(safe_read(args.features))
        parts.append("```")
        parts.append("")
    if args.plan:
        parts.append("## 工艺路线（process_plan）")
        parts.append("```json")
        parts.append(safe_read(args.plan))
        parts.append("```")
        parts.append("")
    if args.gcode:
        parts.append("## 生成的 G-code")
        parts.append("```")
        parts.append(safe_read(args.gcode))
        parts.append("```")
        parts.append("")
    if args.lint:
        parts.append("## lint_gcode.py 输出")
        parts.append("```")
        parts.append(safe_read(args.lint))
        parts.append("```")
        parts.append("")
    parts.append("---")
    parts.append("**严格按 system prompt 里的清单审查，输出指定 JSON 格式。**")
    user_prompt = "\n".join(parts)

    t0 = time.time()
    resp = call_llm(
        cfg["base"], key, cfg["model"],
        system=system_prompt,
        user=user_prompt,
        max_tokens=cfg.get("defaultMaxTokens", 4096),
    )
    elapsed = time.time() - t0

    if "_http_error" in resp:
        print(json.dumps({
            "error": f"HTTP {resp['_http_error']}",
            "body": resp.get("_body", ""),
            "elapsed_s": round(elapsed, 1),
        }, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    if "_error" in resp:
        print(json.dumps({"error": resp["_error"], "elapsed_s": round(elapsed, 1)}, ensure_ascii=False), file=sys.stderr)
        return 1

    raw = (resp.get("choices") or [{}])[0].get("message", {}).get("content", "")
    if not raw:
        print(json.dumps({"error": "empty response", "raw_resp_keys": list(resp.keys())}, ensure_ascii=False), file=sys.stderr)
        return 1

    # 解析 JSON
    review: dict = {}
    m = re.search(r"\{[\s\S]*\}", raw)
    if m:
        try:
            review = json.loads(m.group(0))
        except Exception as e:
            review = {"_parse_error": str(e), "raw_text": raw[:1500]}
    else:
        review = {"raw_text": raw[:1500]}

    review["_meta"] = {
        "elapsed_s": round(elapsed, 1),
        "model": cfg["model"],
        "tokens": resp.get("usage", {}),
    }

    out_text = json.dumps(review, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(out_text, encoding="utf-8")
        # 终端只打概要
        summary = {
            "verdict": review.get("verdict"),
            "score": review.get("score"),
            "critical_issues_count": len(review.get("critical_issues") or []),
            "warnings_count": len(review.get("warnings") or []),
            "out": args.out,
            "elapsed_s": review["_meta"]["elapsed_s"],
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(out_text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
