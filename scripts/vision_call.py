#!/usr/bin/env python3
"""
vision_call.py — 让 Claude 主大脑通过 Bash 调用 vision helper 池看图。

设计目的：
    Claude 用自己的 Read 看图很贵且慢。改用：
        Qwen3.6-Plus VL (主)  +  Kimi-K2.5 VL (异源验)  →  DeepSeek-R1 对比
    便宜、快、有交叉验证。

用法：
    python scripts/vision_call.py <image_path> [--prompt "..."]
                                   [--no-verify]              只跑主 vision，跳过互验
                                   [--system "..."]            额外的 system prompt 追加
                                   [--out result.json]         结果落盘

输出（stdout JSON）：
    {
      "image": "...",
      "primary": { "provider": "qwen3.6-plus", "content": "...", "tokens": {...} },
      "verify":  { "provider": "kimi-k2.5",     "content": "...", "tokens": {...} } | null,
      "agree":   true | false | null,
      "disagreements": "如果 agree=false，列关键差异；agree=true 则 'none'",
      "elapsed_ms": { "primary": 0, "verify": 0, "compare": 0, "total": 0 },
      "skill_loaded": true | false
    }

依赖：
    - 项目根目录的 config/helpers.json
    - 项目根目录的 .env（含 ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / ALIYUN_DASHSCOPE_KEY）
    - 项目根目录的 skills/drawing-recognition.md（可选，找得到就自动注入）
"""
from __future__ import annotations
import argparse
import base64
import concurrent.futures as cf
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# 强制 UTF-8 stdout
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# 解析项目根目录（假设脚本在 <root>/scripts/ 下）
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
CONFIG_PATH = PROJECT_ROOT / "config" / "helpers.json"
ENV_PATH = PROJECT_ROOT / ".env"
SKILL_PATH = PROJECT_ROOT / "skills" / "drawing-recognition.md"

DEFAULT_PROMPT = "请按你的 system prompt（识图手册）流程精准识图，最后输出 §7 标准 JSON。"


def load_env(path: Path) -> dict:
    """简易 .env 解析。.env 文件值**覆盖** os.environ 已有值（项目配置优先）。"""
    env = dict(os.environ)
    if not path.exists():
        return env
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k:
                env[k] = v  # 项目 .env 覆盖系统级
    except Exception:
        pass
    return env


def load_helpers_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[warn] failed to parse helpers.json: {e}", file=sys.stderr)
        return {}


def load_skill() -> str | None:
    if not SKILL_PATH.exists():
        return None
    try:
        return SKILL_PATH.read_text(encoding="utf-8")
    except Exception:
        return None


def infer_image_mime(path: Path) -> str:
    ext = path.suffix.lstrip(".").lower()
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "bmp": "image/bmp",
    }.get(ext, "image/png")


def encode_image(path: Path) -> str:
    mime = infer_image_mime(path)
    with path.open("rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return f"data:{mime};base64,{b64}"


def call_openai_compat(
    base: str,
    api_key: str,
    model: str,
    messages: list,
    max_tokens: int = 2048,
    temperature: float = 0.1,
    timeout_sec: int = 120,
) -> dict:
    body = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }
    url = base.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return {"_http_error": e.code, "_body": body[:500]}
    except Exception as e:
        return {"_error": str(e)}


def extract_text(resp: dict) -> str | None:
    if "_http_error" in resp or "_error" in resp:
        return None
    msg = (resp.get("choices") or [{}])[0].get("message") or {}
    c = msg.get("content")
    return c if isinstance(c, str) and c.strip() else None


def extract_usage(resp: dict) -> dict:
    return resp.get("usage", {})


def call_vision_role(
    role: str,
    image_data_url: str,
    user_prompt: str,
    system_prompt: str | None,
    config: dict,
    env: dict,
) -> tuple[dict, float]:
    """调单一 vision 角色。返回 (响应包装, 耗时秒)。"""
    cfg = config.get(role) or config.get("default")
    if not cfg:
        return {"_error": f"role {role} not configured"}, 0.0
    key = env.get(cfg.get("key_env", ""))
    if not key:
        return {"_error": f"key {cfg.get('key_env')} not set in env"}, 0.0

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({
        "role": "user",
        "content": [
            {"type": "text", "text": user_prompt},
            {"type": "image_url", "image_url": {"url": image_data_url}},
        ],
    })
    t0 = time.time()
    raw = call_openai_compat(
        base=cfg["base"],
        api_key=key,
        model=cfg["model"],
        messages=messages,
        max_tokens=cfg.get("defaultMaxTokens", 2048),
        temperature=cfg.get("defaultTemperature", 0.1),
    )
    elapsed = time.time() - t0
    return raw, elapsed


def call_reason_compare(primary: str, verify: str, config: dict, env: dict) -> tuple[dict, float]:
    """让 reason helper 对比两个视觉模型输出，返回 agree+disagreements。"""
    cfg = config.get("reason") or config.get("default")
    if not cfg:
        return {"_error": "reason role not configured"}, 0.0
    key = env.get(cfg.get("key_env", ""))
    if not key:
        return {"_error": f"key {cfg.get('key_env')} not set"}, 0.0

    prompt = (
        "两个不同的视觉模型对同一张工程图给出了答案。请判断它们是否一致"
        "（特别关注：尺寸数字、特征数量、几何关系、孔/槽/螺纹的识别）。\n\n"
        f"模型 A（Qwen3.6）输出：\n```\n{primary[:2500]}\n```\n\n"
        f"模型 B（Kimi-K2.5）输出：\n```\n{verify[:2500]}\n```\n\n"
        '只回答如下 JSON（不要任何其他文字）：\n'
        '{"agree": true|false, "disagreements": "若不一致列关键差异；若一致写 none"}'
    )
    messages = [{"role": "user", "content": prompt}]
    t0 = time.time()
    raw = call_openai_compat(
        base=cfg["base"],
        api_key=key,
        model=cfg["model"],
        messages=messages,
        max_tokens=cfg.get("defaultMaxTokens", 2048),
        temperature=0.0,
    )
    elapsed = time.time() - t0
    return raw, elapsed


def main() -> int:
    ap = argparse.ArgumentParser(description="双 vision LLM 看图 + DeepSeek-R1 互验")
    ap.add_argument("image", help="图片路径（PNG/JPG/...）")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT, help="给视觉模型的文字提问")
    ap.add_argument("--no-verify", action="store_true", help="跳过互验，只跑主 vision")
    ap.add_argument("--system", default="", help="额外追加的 system prompt")
    ap.add_argument("--out", default="", help="结果写入此文件（json）")
    args = ap.parse_args()

    image_path = Path(args.image)
    if not image_path.exists():
        print(json.dumps({"error": f"image not found: {image_path}"}, ensure_ascii=False), file=sys.stderr)
        return 2

    env = load_env(ENV_PATH)
    config = load_helpers_config()
    skill = load_skill()

    sys_parts = []
    if skill:
        sys_parts.append(skill)
    if args.system:
        sys_parts.append(args.system)
    system_prompt = "\n\n---\n\n".join(sys_parts) if sys_parts else None

    image_data_url = encode_image(image_path)
    t_total = time.time()

    # 主 vision + 互验并发
    if args.no_verify:
        primary_raw, t_primary = call_vision_role("vision", image_data_url, args.prompt, system_prompt, config, env)
        verify_raw, t_verify = ({}, 0.0)
    else:
        with cf.ThreadPoolExecutor(max_workers=2) as pool:
            fut_p = pool.submit(call_vision_role, "vision", image_data_url, args.prompt, system_prompt, config, env)
            fut_v = pool.submit(call_vision_role, "vision_verify", image_data_url, args.prompt, system_prompt, config, env)
            primary_raw, t_primary = fut_p.result()
            verify_raw, t_verify = fut_v.result()

    primary_text = extract_text(primary_raw)
    verify_text = extract_text(verify_raw) if not args.no_verify else None

    # 对比
    agree = None
    disagreements = None
    compare_error = None
    t_compare = 0.0
    if primary_text and verify_text:
        cmp_raw, t_compare = call_reason_compare(primary_text, verify_text, config, env)
        # 暴露错误，避免被静默吞掉
        if isinstance(cmp_raw, dict):
            if "_error" in cmp_raw:
                compare_error = f"network: {cmp_raw['_error']}"
            elif "_http_error" in cmp_raw:
                compare_error = f"HTTP {cmp_raw['_http_error']}: {cmp_raw.get('_body','')[:200]}"
        cmp_text = extract_text(cmp_raw)
        if cmp_text:
            m = re.search(r"\{[\s\S]*\}", cmp_text)
            if m:
                try:
                    parsed = json.loads(m.group(0))
                    agree = bool(parsed.get("agree"))
                    disagreements = parsed.get("disagreements")
                except Exception:
                    disagreements = cmp_text[:500]
            else:
                disagreements = cmp_text[:500]

    out = {
        "image": str(image_path),
        "primary": {
            "provider": (config.get("vision") or {}).get("model", "?"),
            "content": primary_text,
            "tokens": extract_usage(primary_raw) if isinstance(primary_raw, dict) else {},
            "error": primary_raw.get("_error") or primary_raw.get("_http_error"),
        },
        "verify": None if args.no_verify else {
            "provider": (config.get("vision_verify") or {}).get("model", "?"),
            "content": verify_text,
            "tokens": extract_usage(verify_raw) if isinstance(verify_raw, dict) else {},
            "error": verify_raw.get("_error") or verify_raw.get("_http_error"),
        },
        "agree": agree,
        "disagreements": disagreements,
        "compare_error": compare_error,
        "elapsed_ms": {
            "primary": int(t_primary * 1000),
            "verify": int(t_verify * 1000),
            "compare": int(t_compare * 1000),
            "total": int((time.time() - t_total) * 1000),
        },
        "skill_loaded": skill is not None,
    }

    if args.out:
        Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"ok": True, "out": args.out, "agree": agree, "elapsed_ms": out["elapsed_ms"]}, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
