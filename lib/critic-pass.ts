/**
 * Critic Pass —— 任务结束后的强制独立审计。
 *
 * 设计：
 *   - 任务进入 done 之前，独立角色（helper('verify')）跑一道审计
 *   - 用 critic-checklist.md 作 system prompt（不是 main agent 复述）
 *   - 输入：用户 prompt + assistant 最终输出片段 + workspace 文件列表
 *   - 输出：JSON {verdict: pass|warn|fail, issues: [{severity, area, detail, fix?}]}
 *   - 把结果发成 criticReport 事件 + 一条 assistant chat（让用户看到）
 *
 * 触发条件：
 *   - lite: 跳过（成本/价值不匹配）
 *   - standard: 只要有产物（workspace 有非 uploads/parsed 文件）就跑
 *   - heavy / forceCritic: 必跑
 *
 * 模型：helper('verify')（DeepSeek-V3 或类似），~¥0.005/次
 */

import path from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { helper } from './helper-llm';
import { listAllEvents } from './db';
import type { TaskMode } from './task-classifier';
import type { AgentEvent } from './types';

const PROJECT_ROOT = process.cwd();
const CRITIC_SKILL_PATH = path.join(PROJECT_ROOT, 'skills', 'critic-checklist.md');

const HIDDEN_DIRS = new Set(['skills', 'scripts', 'knowledge', 'parsed', 'config', '.claude', 'uploads']);
const MAX_FILE_SAMPLE = 4000; // chars per file sample we feed to critic
const MAX_FILES_INSPECTED = 6;

export type CriticIssue = {
  severity: 'critical' | 'major' | 'minor';
  area: string;
  detail: string;
  fix?: string;
};

export type CriticVerdict = 'pass' | 'warn' | 'fail' | 'skipped';

export type CriticReport = {
  verdict: CriticVerdict;
  summary: string;
  issues: CriticIssue[];
  /** Files actually inspected (relative paths). */
  inspected: string[];
  /** What model/role ran the audit. */
  ranBy: string;
  /** Why the critic was skipped (if verdict === 'skipped'). */
  skippedReason?: string;
};

type WorkspaceProduct = {
  rel: string;
  abs: string;
  size: number;
  ext: string;
};

/** Walk workspace and pick "user-facing" product files (not internal). */
function listProducts(workspaceDir: string): WorkspaceProduct[] {
  const out: WorkspaceProduct[] = [];
  function walk(rel: string) {
    const abs = path.join(workspaceDir, rel);
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const childRel = path.posix.join(rel.replace(/\\/g, '/'), ent.name);
      if (rel === '' && HIDDEN_DIRS.has(ent.name)) continue;
      if (ent.isDirectory()) {
        walk(childRel);
      } else if (ent.isFile()) {
        try {
          const st = statSync(path.join(abs, ent.name));
          out.push({
            rel: childRel,
            abs: path.join(workspaceDir, childRel),
            size: st.size,
            ext: path.extname(ent.name).slice(1).toLowerCase(),
          });
        } catch { /* ignore */ }
      }
    }
  }
  walk('');
  // Sort: prefer recently modified / structured artifacts first
  return out.sort((a, b) => {
    const priorityExt = (e: string) =>
      ({ nc: 0, gcode: 0, ngc: 0, html: 1, pptx: 1, docx: 1, pdf: 1, json: 2, py: 3, md: 3, txt: 4 }[e] ?? 5);
    const pa = priorityExt(a.ext);
    const pb = priorityExt(b.ext);
    if (pa !== pb) return pa - pb;
    return b.size - a.size;
  });
}

/** Pick the assistant's last few text messages (the final answer). */
function extractAssistantTail(events: AgentEvent[], maxChars = 3500): string {
  const tails: string[] = [];
  let total = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'chat' && e.sender === 'assistant' && e.content) {
      const c = String(e.content);
      tails.unshift(c);
      total += c.length;
      if (total >= maxChars) break;
    }
  }
  return tails.join('\n\n').slice(-maxChars);
}

/** Pick a subset of products and read a snippet of each. */
function buildProductSamples(products: WorkspaceProduct[]): { samples: string; inspected: string[] } {
  const sub = products.slice(0, MAX_FILES_INSPECTED);
  const inspected: string[] = [];
  const blocks: string[] = [];
  for (const p of sub) {
    inspected.push(p.rel);
    let snippet = '';
    // Only inspect text-like files
    const isText = ['nc', 'ngc', 'gcode', 'json', 'md', 'txt', 'html', 'css', 'js', 'py', 'csv', 'xml', 'svg'].includes(p.ext);
    if (isText) {
      try {
        const buf = readFileSync(p.abs, 'utf-8');
        snippet = buf.length > MAX_FILE_SAMPLE
          ? buf.slice(0, MAX_FILE_SAMPLE) + `\n... (截断，共 ${buf.length} 字符)`
          : buf;
      } catch (err) {
        snippet = `[读取失败：${(err as Error).message}]`;
      }
    } else {
      snippet = `[二进制文件，${(p.size / 1024).toFixed(1)} KB；不展开内容，仅按存在性审计]`;
    }
    blocks.push(`### ${p.rel} (${p.ext}, ${(p.size / 1024).toFixed(1)} KB)\n\`\`\`\n${snippet}\n\`\`\``);
  }
  return { samples: blocks.join('\n\n'), inspected };
}

/** Build the critic prompt — domain-aware. */
function buildCriticPrompt(args: {
  userPrompt: string;
  assistantTail: string;
  fileList: string[];
  productSamples: string;
  taskMode: TaskMode;
}): string {
  const { userPrompt, assistantTail, fileList, productSamples, taskMode } = args;
  const fileLines = fileList.length
    ? fileList.map(f => `  - ${f}`).join('\n')
    : '  (无产物文件)';

  return `你是独立的任务质检 agent。你的工作不是复述 Claude 做了什么，而是**找具体问题**——按下面 4 维打分。

## 用户原始请求
${userPrompt.slice(0, 1500)}

## Assistant 最终输出（结尾片段）
${assistantTail || '(无)'}

## 工作区产物列表
${fileLines}

## 抽样的产物内容（最多 ${MAX_FILES_INSPECTED} 个）
${productSamples || '(无可展开的文本产物)'}

## 4 维审查（每条都要明确判断）

**A. 完成度** — 用户要的东西做了吗？
- 用户列出的具体要求每条都有对应产物吗？
- 任务声称"完成"但实际产物缺失的（"我帮你写了 PPT"但没 .pptx 文件）？

**B. 质量** — 产物本身有没有明显瑕疵？
- 文件能用吗（不是空文件、不是错误信息文件）？
- 内容跟用户主题相关吗（不是把 G-code 写成 HTML）？
- 中文/英文有没有明显错误（例如代码注释和正文语种混乱、乱码、占位符 "{TODO}" 没替换）？
- 数字/参数是否有显著不合理（CNC 转速 100k、PPT 100 张）？

**C. 一致性** — assistant 的话和实际产物对得上吗？
- 它说"已生成 X.pptx"但文件里没有？
- 它声称的数字/结论跟产物里的不同？

**D. 领域专项**（按任务类型激活相应清单）
${taskMode === 'heavy' ? '- HEAVY 任务必查：critic-checklist 5 大工艺原则 / 基准选择 / 切削参数 / 材料工艺匹配 / G-code 语法（如有 .nc 产物）' : ''}
- 如有 .pptx：是否每页只有一个核心信息？字号是否够大？是否塞了一墙文字？
- 如有 .docx / .pdf：是否有结构（标题层级、段落）？是否有错别字 / 排版混乱？
- 如有 .html：是否有 DOCTYPE？标题/语义标签是否合理？是否有响应式 viewport meta？
- 如有 .nc/.gcode：参考 critic-checklist.md 的 5 大原则 + ABCDEF 维度

## 输出格式（严格 JSON，不要 markdown 代码块包裹）

\`\`\`
{
  "verdict": "pass" | "warn" | "fail",
  "summary": "1-2 句总评",
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "area": "completeness | quality | consistency | domain",
      "detail": "具体问题，引用文件/行号",
      "fix": "建议怎么改（可省略）"
    }
  ]
}
\`\`\`

判断规则：
- **pass**：4 维都没明显问题。issues 可以为空数组
- **warn**：有 minor / major 但用户产物基本可用
- **fail**：有 critical 问题（用户主要要求未完成 / 产物根本不可用 / 严重错误）

只输出 JSON，不要其它前后缀文字。`;
}

function tryParseJson(s: string): { verdict?: string; summary?: string; issues?: any[] } | null {
  // Strip markdown fences if present
  let cleaned = s.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  // Find first { and last }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Run a critic pass.
 * @returns CriticReport with verdict + issues (or skipped if not applicable)
 */
export async function runCriticPass(args: {
  sessionId: string;
  userPrompt: string;
  taskMode: TaskMode;
  forceCritic: boolean;
  workspaceDir: string;
}): Promise<CriticReport> {
  const { sessionId, userPrompt, taskMode, forceCritic, workspaceDir } = args;

  // Skip rules
  if (taskMode === 'lite') {
    return {
      verdict: 'skipped',
      summary: 'lite 任务跳过审计',
      issues: [],
      inspected: [],
      ranBy: 'none',
      skippedReason: 'lite-mode',
    };
  }

  const products = listProducts(workspaceDir);
  if (products.length === 0 && taskMode === 'standard' && !forceCritic) {
    return {
      verdict: 'skipped',
      summary: '无产物，跳过审计',
      issues: [],
      inspected: [],
      ranBy: 'none',
      skippedReason: 'no-products',
    };
  }

  // Pull events for this session
  let events: AgentEvent[];
  try {
    events = listAllEvents(sessionId);
  } catch (err) {
    return {
      verdict: 'skipped',
      summary: '事件读取失败，跳过审计',
      issues: [],
      inspected: [],
      ranBy: 'none',
      skippedReason: `events-read-failed: ${(err as Error).message}`,
    };
  }
  const assistantTail = extractAssistantTail(events);
  if (!assistantTail && products.length === 0) {
    return {
      verdict: 'skipped',
      summary: '无可审计内容',
      issues: [],
      inspected: [],
      ranBy: 'none',
      skippedReason: 'no-content',
    };
  }

  const { samples, inspected } = buildProductSamples(products);
  const fileList = products.map(p => p.rel);

  // Build prompt + load critic-checklist as system prompt for HEAVY tasks
  const prompt = buildCriticPrompt({
    userPrompt,
    assistantTail,
    fileList,
    productSamples: samples,
    taskMode,
  });

  let systemPrompt: string | undefined;
  if (taskMode === 'heavy' && existsSync(CRITIC_SKILL_PATH)) {
    try {
      systemPrompt = readFileSync(CRITIC_SKILL_PATH, 'utf-8');
    } catch { /* ignore */ }
  }

  let response: string | null = null;
  try {
    response = await helper('verify', prompt, {
      maxTokens: 1500,
      temperature: 0.1,
      system: systemPrompt,
      progress: { sessionId, label: '审计产物（critic）' },
    });
  } catch (err) {
    return {
      verdict: 'skipped',
      summary: `helper 调用失败：${(err as Error).message}`,
      issues: [],
      inspected,
      ranBy: 'verify (failed)',
      skippedReason: 'helper-error',
    };
  }
  if (!response || !response.trim()) {
    return {
      verdict: 'skipped',
      summary: 'critic 模型无响应',
      issues: [],
      inspected,
      ranBy: 'verify (empty)',
      skippedReason: 'empty-response',
    };
  }

  const parsed = tryParseJson(response);
  if (!parsed) {
    // Best-effort: treat as warn with raw text
    return {
      verdict: 'warn',
      summary: 'critic 输出无法解析为 JSON（保留原文）',
      issues: [
        { severity: 'minor', area: 'meta', detail: response.slice(0, 600) },
      ],
      inspected,
      ranBy: 'verify',
    };
  }

  const verdict = (
    parsed.verdict === 'pass' || parsed.verdict === 'warn' || parsed.verdict === 'fail'
      ? parsed.verdict
      : 'warn'
  ) as CriticVerdict;

  const issues: CriticIssue[] = Array.isArray(parsed.issues)
    ? parsed.issues
        .filter((it: any) => it && typeof it === 'object')
        .map((it: any) => ({
          severity: ['critical', 'major', 'minor'].includes(it.severity)
            ? (it.severity as CriticIssue['severity'])
            : 'minor',
          area: String(it.area ?? 'general').slice(0, 40),
          detail: String(it.detail ?? '').slice(0, 800),
          fix: it.fix ? String(it.fix).slice(0, 400) : undefined,
        }))
    : [];

  return {
    verdict,
    summary: String(parsed.summary ?? '').slice(0, 400),
    issues,
    inspected,
    ranBy: 'verify',
  };
}
