/**
 * Helper LLM 抽象 — Claude 是大脑，国产模型按职能分工做"专家小队"。
 *
 * 设计原则：
 *   - 对外只暴露职能（reason / verify / summarize / write_chinese / suggest / extract）
 *   - 每个职能背后绑定一个 provider+model（在 config/helpers.json 配置）
 *   - 配置缺失或调用失败 → 用 fallback（Claude）
 *   - Provider 必须是 OpenAI Chat Completions 兼容协议
 *
 * 配置文件：config/helpers.json （不进 git）
 * 配置模板：config/helpers.example.json
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { appendEvent } from './db';
import type { AgentEvent } from './types';

// ---- helperProgress emitter -------------------------------------------------
// Optional progress events so UI can show "正在让 verify 模型审核..." instead of
// going dark when a helper call takes 5-30s.
function emitProgress(
  sessionId: string,
  state: 'started' | 'finished' | 'error',
  meta: Record<string, unknown>,
): void {
  const ev: AgentEvent = {
    id: nanoid(22),
    sessionId,
    type: 'helperProgress',
    timestamp: Date.now(),
    payload: { state, ...meta },
  };
  try { appendEvent(ev); } catch { /* don't let progress reporting break the call */ }
}

export type HelperProgress = {
  /** Session to attach the helperProgress events to. Required to enable. */
  sessionId: string;
  /** Short human-readable label, e.g. "审计产物" / "蒸馏 skill draft" / "看图". */
  label: string;
};

// ---- Vision skill 自动注入 ------------------------------------------
// 让 vision helper 调用时自动以 skills/drawing-recognition.md 为 system prompt，
// 大幅提升识图精度（按扫描清单/三视图规律/符号字典走）。
const VISION_SKILL_PATH = path.join(process.cwd(), 'skills', 'drawing-recognition.md');
let _visionSkillCache: string | null | undefined = undefined; // undefined = 未尝试，null = 没有

function loadVisionSkill(): string | null {
  if (_visionSkillCache !== undefined) return _visionSkillCache;
  try {
    if (existsSync(VISION_SKILL_PATH)) {
      _visionSkillCache = readFileSync(VISION_SKILL_PATH, 'utf-8');
    } else {
      _visionSkillCache = null;
    }
  } catch {
    _visionSkillCache = null;
  }
  return _visionSkillCache;
}

export type HelperRole =
  | 'reason'        // 复杂推理（数学、逻辑、调试）
  | 'verify'        // 校验（是非判断、规则检查）
  | 'summarize'     // 长文总结（搜索结果、PDF）
  | 'write_chinese' // 中文创作
  | 'suggest'       // 任务后建议生成
  | 'extract'       // 自由文本→结构化 JSON
  | 'vision'        // 视觉理解主力（看图 / OCR）
  | 'vision_verify' // 视觉互验（第二个 VL 模型对比）
  | 'code_gen'      // 代码批量生成（G-code/PLC 等）
  | 'default';

// ===========================================================================
// Capability Router (Phase 0) —— 让模型按能力被自动选择，而不是死绑角色
// ===========================================================================

export type Capability =
  | 'reasoning'      // 复杂推理（CoT / 多步逻辑）
  | 'vision'         // 视觉理解（看图）
  | 'long_context'   // 长上下文（>50K tokens）
  | 'chinese'        // 中文创作质量
  | 'code'           // 代码生成
  | 'cheap'          // 价格便宜
  | 'fast'           // 响应速度（无 reasoning 开销）
  | 'function_call'; // 工具调用稳定性

type ModelEntry = {
  base: string;
  key_env: string;
  model: string;
  caps: Partial<Record<Capability, number>>;
  /** 是否需要 vision 专用 endpoint（OpenAI 兼容下不接受 image_url 的模型置 false 或省略 vision 评分） */
  notes?: string;
};

/**
 * 内置模型注册（capability matrix 用于路由）。
 * 评分基于行业基准 + 项目内实测（vision 实测、code 实测等）。
 * 0 = 不支持 / 1-2 = 弱 / 3 = 一般 / 4 = 强 / 5 = 顶尖
 */
const MODEL_REGISTRY: Record<string, ModelEntry> = {
  'deepseek-r1': {
    base: 'https://api.deepseek.com/v1',
    key_env: 'DEEPSEEK_API_KEY',
    model: 'deepseek-reasoner',
    caps: { reasoning: 5, code: 4, cheap: 3, fast: 1, chinese: 3, function_call: 3 },
  },
  'deepseek-v3': {
    base: 'https://api.deepseek.com/v1',
    key_env: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
    caps: { reasoning: 3, code: 4, cheap: 5, fast: 5, chinese: 3, function_call: 4 },
  },
  'kimi-k2.5': {
    base: 'https://coding.dashscope.aliyuncs.com/v1',
    key_env: 'ALIYUN_DASHSCOPE_KEY',
    model: 'kimi-k2.5',
    caps: { reasoning: 3, vision: 3, long_context: 5, chinese: 4, fast: 2 },
  },
  'minimax-m2.5': {
    base: 'https://coding.dashscope.aliyuncs.com/v1',
    key_env: 'ALIYUN_DASHSCOPE_KEY',
    model: 'MiniMax-M2.5',
    caps: { reasoning: 3, chinese: 5, code: 3 },
    notes: '在 OpenAI 兼容端点不接受 image_url，vision 评分留空',
  },
  'qwen3.6-plus': {
    base: 'https://coding.dashscope.aliyuncs.com/v1',
    key_env: 'ALIYUN_DASHSCOPE_KEY',
    model: 'qwen3.6-plus',
    caps: { reasoning: 3, vision: 4, chinese: 4, code: 4, function_call: 5 },
  },
  'qwen3.5-plus': {
    base: 'https://coding.dashscope.aliyuncs.com/v1',
    key_env: 'ALIYUN_DASHSCOPE_KEY',
    model: 'qwen3.5-plus',
    caps: { reasoning: 3, vision: 3, chinese: 4, code: 3, function_call: 4 },
  },
  'glm-5': {
    base: 'https://coding.dashscope.aliyuncs.com/v1',
    key_env: 'ALIYUN_DASHSCOPE_KEY',
    model: 'glm-5',
    caps: { reasoning: 3, code: 5, chinese: 3, fast: 3 },
    notes: '实测 FANUC G-code 写得最地道',
  },
  'qwen3-coder-plus': {
    base: 'https://coding.dashscope.aliyuncs.com/v1',
    key_env: 'ALIYUN_DASHSCOPE_KEY',
    model: 'qwen3-coder-plus',
    caps: { code: 4, cheap: 3, fast: 4 },
  },
};

/** 角色 → 能力需求（让旧 helper(role) API 自动走能力路由）。 */
const ROLE_TO_CAPS: Record<HelperRole, Capability[]> = {
  reason: ['reasoning'],
  verify: ['cheap', 'fast'],
  summarize: ['long_context'],
  write_chinese: ['chinese'],
  suggest: ['cheap', 'fast', 'chinese'],
  extract: ['function_call'],
  vision: ['vision'],
  vision_verify: ['vision'], // 互验时通过 excludeModels 拒掉 primary 选过的
  code_gen: ['code'],
  default: ['cheap'],
};

/** 必须强制的"硬约束"能力——0 分直接淘汰候选。 */
const HARD_CAPS: Set<Capability> = new Set(['vision', 'long_context']);

/**
 * 路由：基于能力打分选最佳模型。
 * 纯本地算法，O(模型数 × 能力数) ≈ 64 次乘加比较，亚毫秒级。
 *
 * @param needs   该任务需要的能力标签
 * @param options excludeModels 用于异源互验；preferCheap/promptLength 微调评分
 * @returns 选中的 modelKey（在 MODEL_REGISTRY 里的 key）
 */
export function routeByCaps(
  needs: Capability[],
  options?: {
    excludeModels?: string[];
    preferCheap?: boolean;
    promptLength?: number;
  },
): string | null {
  let best = '';
  let bestScore = -Infinity;
  for (const [key, entry] of Object.entries(MODEL_REGISTRY)) {
    if (options?.excludeModels?.includes(key)) continue;

    let blocked = false;
    let score = 0;
    for (const c of needs) {
      const s = entry.caps[c] ?? 0;
      if (HARD_CAPS.has(c) && s < 3) {
        blocked = true;
        break; // 视觉、长上下文这种必须有，弱了就淘汰
      }
      score += s;
    }
    if (blocked) continue;

    // 软偏好
    if (options?.preferCheap) score += (entry.caps.cheap ?? 0) * 0.5;
    if (options?.promptLength && options.promptLength < 1500) {
      score += (entry.caps.fast ?? 0) * 0.3;
    }

    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return best || null;
}

/** 获取已注册模型的 provider 配置（不含 key 值，只含 key_env）。 */
export function getModelEntry(modelKey: string): ModelEntry | null {
  return MODEL_REGISTRY[modelKey] ?? null;
}

/** 列出所有注册模型 + caps，UI 可视化用。 */
export function listAllModels(): Array<{ key: string; model: string; caps: Partial<Record<Capability, number>> }> {
  return Object.entries(MODEL_REGISTRY).map(([key, entry]) => ({
    key,
    model: entry.model,
    caps: entry.caps,
  }));
}

export type HelperConfig = {
  base: string;          // OpenAI 兼容端点 base url（含 /v1）
  key_env: string;       // 从哪个环境变量读取 key
  model: string;
  description?: string;
  defaultMaxTokens?: number;
  defaultTemperature?: number;
};

export type HelpersConfig = Partial<Record<HelperRole, HelperConfig>>;

let _config: HelpersConfig | null = null;

function loadConfig(): HelpersConfig {
  if (_config) return _config;
  const cfgPath = path.join(process.cwd(), 'config', 'helpers.json');
  if (existsSync(cfgPath)) {
    try {
      _config = JSON.parse(readFileSync(cfgPath, 'utf-8')) as HelpersConfig;
      return _config;
    } catch (err) {
      console.error('[helper-llm] failed to parse config/helpers.json', err);
    }
  }
  _config = {};
  return _config;
}

// 解析 .env 文件，**项目级 .env 覆盖系统级 env**
// 防止系统残留的 DEEPSEEK_API_KEY/ANTHROPIC_API_KEY 等覆盖项目配置
let _envFileCache: Record<string, string> | null = null;
function loadProjectEnv(): Record<string, string> {
  if (_envFileCache !== null) return _envFileCache;
  _envFileCache = {};
  const envPath = path.join(process.cwd(), '.env');
  try {
    if (existsSync(envPath)) {
      const text = readFileSync(envPath, 'utf-8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const idx = trimmed.indexOf('=');
        const k = trimmed.slice(0, idx).trim();
        let v = trimmed.slice(idx + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (k) _envFileCache[k] = v;
      }
    }
  } catch (err) {
    console.warn('[helper-llm] .env load failed:', err);
  }
  return _envFileCache;
}

function resolveKey(cfg: HelperConfig): string | undefined {
  // 项目 .env 优先，回退到 process.env
  const fromFile = loadProjectEnv()[cfg.key_env];
  const v = fromFile || process.env[cfg.key_env];
  return v && v.trim() ? v : undefined;
}

/**
 * 调用一个 helper 角色完成简单的单轮请求。
 * 失败时返回 null（调用方自行决定是否 fallback）。
 */
export async function helper(
  role: HelperRole,
  prompt: string,
  options?: {
    maxTokens?: number;
    temperature?: number;
    system?: string;
    progress?: HelperProgress;
  },
): Promise<string | null> {
  const config = loadConfig();
  const cfg = config[role] ?? config.default;
  if (!cfg) {
    if (options?.progress) {
      emitProgress(options.progress.sessionId, 'error', {
        role,
        label: options.progress.label,
        reason: 'role-not-configured',
      });
    }
    return null;
  }
  const key = resolveKey(cfg);
  if (!key) {
    console.warn(`[helper-llm] role=${role}: key_env=${cfg.key_env} not set, skipping`);
    if (options?.progress) {
      emitProgress(options.progress.sessionId, 'error', {
        role,
        label: options.progress.label,
        reason: `key_env=${cfg.key_env}-not-set`,
      });
    }
    return null;
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (options?.system) messages.push({ role: 'system', content: options.system });
  messages.push({ role: 'user', content: prompt });

  const body = {
    model: cfg.model,
    messages,
    max_tokens: options?.maxTokens ?? cfg.defaultMaxTokens ?? 2048,
    temperature: options?.temperature ?? cfg.defaultTemperature ?? 0.3,
    stream: false,
  };

  const startedAt = Date.now();
  if (options?.progress) {
    emitProgress(options.progress.sessionId, 'started', {
      role,
      label: options.progress.label,
      model: cfg.model,
    });
  }

  try {
    const r = await fetch(`${cfg.base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error(`[helper-llm] role=${role} HTTP ${r.status}: ${errText.slice(0, 200)}`);
      if (options?.progress) {
        emitProgress(options.progress.sessionId, 'error', {
          role,
          label: options.progress.label,
          status: r.status,
          durationMs: Date.now() - startedAt,
        });
      }
      return null;
    }
    const j: any = await r.json();
    const text = j?.choices?.[0]?.message?.content;
    const out = typeof text === 'string' ? text : null;
    if (options?.progress) {
      emitProgress(options.progress.sessionId, 'finished', {
        role,
        label: options.progress.label,
        ok: !!out,
        durationMs: Date.now() - startedAt,
        chars: out?.length ?? 0,
      });
    }
    return out;
  } catch (err) {
    console.error(`[helper-llm] role=${role} call failed:`, err);
    if (options?.progress) {
      emitProgress(options.progress.sessionId, 'error', {
        role,
        label: options.progress.label,
        reason: String(err),
        durationMs: Date.now() - startedAt,
      });
    }
    return null;
  }
}

/** 返回当前已配置且 key 已设置的角色，便于 UI 展示。 */
export function listAvailableRoles(): HelperRole[] {
  const config = loadConfig();
  const out: HelperRole[] = [];
  const allRoles: HelperRole[] = [
    'reason', 'verify', 'summarize', 'write_chinese',
    'suggest', 'extract', 'vision', 'vision_verify', 'code_gen',
  ];
  for (const role of allRoles) {
    const cfg = config[role] ?? config.default;
    if (cfg && resolveKey(cfg)) out.push(role);
  }
  return out;
}

// ---- 视觉调用（OpenAI 兼容多模态格式） -----------------------------

function inferImageMime(p: string): string {
  const ext = path.extname(p).slice(1).toLowerCase();
  switch (ext) {
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp':  return 'image/bmp';
    default:     return 'image/png';
  }
}

/**
 * 调 vision helper 看图。
 * @param imagePathOrDataUrl 本地路径 或 已经是 data:image/...;base64,xxx 的 data URL
 * @param prompt 文字提问
 * @param role 'vision'（默认主力）或 'vision_verify'（互验副手）
 */
export async function helperVision(
  imagePathOrDataUrl: string,
  prompt: string,
  options?: { maxTokens?: number; temperature?: number; system?: string; role?: 'vision' | 'vision_verify' },
): Promise<string | null> {
  const config = loadConfig();
  const role = options?.role ?? 'vision';
  const cfg = config[role] ?? config.vision ?? config.default;
  if (!cfg) return null;
  const key = resolveKey(cfg);
  if (!key) {
    console.warn(`[helper-llm] ${role}: key_env=${cfg.key_env} not set, skipping`);
    return null;
  }

  // 构造 image_url
  let imageUrl: string;
  if (imagePathOrDataUrl.startsWith('data:') || imagePathOrDataUrl.startsWith('http')) {
    imageUrl = imagePathOrDataUrl;
  } else {
    if (!existsSync(imagePathOrDataUrl)) {
      console.error(`[helper-llm] vision: file not found ${imagePathOrDataUrl}`);
      return null;
    }
    const buf = readFileSync(imagePathOrDataUrl);
    const mime = inferImageMime(imagePathOrDataUrl);
    imageUrl = `data:${mime};base64,${buf.toString('base64')}`;
  }

  const messages: any[] = [];

  // 自动注入识图 skill（如有）。调用方自定义的 system 追加在 skill 之后。
  const skill = loadVisionSkill();
  const systemParts: string[] = [];
  if (skill) systemParts.push(skill);
  if (options?.system) systemParts.push(options.system);
  if (systemParts.length > 0) {
    messages.push({ role: 'system', content: systemParts.join('\n\n---\n\n') });
  }

  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: imageUrl } },
    ],
  });

  const body = {
    model: cfg.model,
    messages,
    max_tokens: options?.maxTokens ?? cfg.defaultMaxTokens ?? 2048,
    temperature: options?.temperature ?? cfg.defaultTemperature ?? 0.1,
    stream: false,
  };

  try {
    const r = await fetch(`${cfg.base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error(`[helper-llm] ${role} HTTP ${r.status}: ${errText.slice(0, 300)}`);
      return null;
    }
    const j: any = await r.json();
    const text = j?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text : null;
  } catch (err) {
    console.error(`[helper-llm] ${role} call failed:`, err);
    return null;
  }
}

// ---- 双 VL 互验 ----------------------------------------------------

export type CrossCheckResult = {
  primary: string | null;
  verify: string | null;
  agree: boolean | null;     // null = 无法判断（一边或两边失败）
  disagreements?: string;    // 如果不一致，reason 模型给的差异说明
};

/**
 * 同一张图同一个问题，让 vision + vision_verify 都看一遍，再用 reason 模型对比。
 * 用于关键场景（图纸尺寸提取、特征识别），避免单模型误读。
 */
export async function helperVisionCrossCheck(
  imagePath: string,
  prompt: string,
  options?: { maxTokens?: number; temperature?: number; system?: string },
): Promise<CrossCheckResult> {
  const [primary, verify] = await Promise.all([
    helperVision(imagePath, prompt, { ...options, role: 'vision' }),
    helperVision(imagePath, prompt, { ...options, role: 'vision_verify' }),
  ]);

  if (!primary || !verify) {
    return { primary, verify, agree: null };
  }

  // 调 reason 模型对比两份输出
  const compareText = `两个不同的视觉模型对同一张工程图给出了答案。请判断它们是否一致（特别关注：尺寸数字、特征数量、几何关系）。

模型 A 的输出：
"""
${primary.slice(0, 2000)}
"""

模型 B 的输出：
"""
${verify.slice(0, 2000)}
"""

请只回答如下 JSON（不要任何其他文字）：
{"agree": true|false, "disagreements": "若不一致，列出关键差异；若一致，写 'none'"}`;

  const compareResp = await helper('reason', compareText, {
    maxTokens: 800,
    temperature: 0.0,
  });

  if (!compareResp) {
    return { primary, verify, agree: null };
  }

  // 提取 JSON
  try {
    const match = compareResp.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        primary,
        verify,
        agree: !!parsed.agree,
        disagreements: parsed.disagreements,
      };
    }
  } catch {}
  return { primary, verify, agree: null, disagreements: compareResp.slice(0, 500) };
}
