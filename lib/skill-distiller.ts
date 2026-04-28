/**
 * Skill Distiller —— Step 4：把 pending 反思批量蒸馏成 skill draft。
 *
 * 触发：
 *   - 手动：POST /api/skills/distill
 *   - 自动（未来）：cron 检查 backlog pending ≥ 5 OR 距上次 ≥ 7 天
 *
 * 流程：
 *   1. 读 learning_backlog 里 status='pending' 的 sid 列表
 *   2. 对应读 reflections 表
 *   3. 读现有 skills/<*>.md 列表 + frontmatter（避免重复造轮子）
 *   4. 跑 helper('reason') —— 给所有反思 + 现有 skill 索引，让它判断是否有
 *      未覆盖的可复用 pattern；有就按 skill-creator 模板输出 markdown
 *   5. 解析输出 frontmatter + 内容 → skill_drafts 表（status='pending'）
 *   6. 把对应 backlog 标 distilled
 *   7. 如果 LLM 判断 NO_PATTERN 也把这批 backlog 标 distilled（避免反复跑）
 *
 * 模型：helper('reason')，需要中等推理能力 + 长上下文。
 * 价格：~¥0.05 / 次（10 个反思）。
 */

import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { nanoid } from 'nanoid';
import {
  listBacklogByStatus,
  upsertBacklogItem,
  getReflection,
  createSkillDraft,
} from './db';
import { helper } from './helper-llm';

const PROJECT_ROOT = process.cwd();
const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');

/** 默认门槛：pending ≥ 此数才有意义跑蒸馏。 */
export const MIN_PENDING_FOR_AUTO_DISTILL = 5;

type SkillIndexEntry = {
  name: string;
  description: string;
};

/** 读 skills/ 目录下每个 .md 的 frontmatter（name + description）。 */
function loadSkillIndex(): SkillIndexEntry[] {
  const out: SkillIndexEntry[] = [];
  if (!existsSync(SKILLS_DIR)) return out;
  for (const f of readdirSync(SKILLS_DIR)) {
    if (!f.endsWith('.md')) continue;
    try {
      const raw = readFileSync(path.join(SKILLS_DIR, f), 'utf-8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) {
        out.push({ name: f.replace(/\.md$/, ''), description: '(no frontmatter)' });
        continue;
      }
      const name = fm[1].match(/^name:\s*(.+)$/m)?.[1].trim() ?? f.replace(/\.md$/, '');
      const description = fm[1].match(/^description:\s*(.+)$/m)?.[1].trim() ?? '';
      out.push({ name, description: description.slice(0, 240) });
    } catch { /* ignore */ }
  }
  return out;
}

/** 拼蒸馏 prompt。 */
function buildDistillPrompt(args: {
  reflections: Array<{ sid: string; mode: string; title: string; body: string }>;
  skillIndex: SkillIndexEntry[];
}): string {
  const { reflections, skillIndex } = args;
  const reflBlock = reflections
    .map(
      (r, i) =>
        `### 反思 ${i + 1} — ${r.title} (sid=${r.sid}, mode=${r.mode})\n${r.body}`,
    )
    .join('\n\n---\n\n');
  const skillBlock = skillIndex.length
    ? skillIndex.map(s => `- **${s.name}**：${s.description}`).join('\n')
    : '(无 skill)';
  return `你是 Manuscopy 的 skill 蒸馏助理。

## 当前 skills 索引（已存在的 skill，注意避免重复）
${skillBlock}

## 待审 ${reflections.length} 个任务反思
${reflBlock}

## 任务
从这批反思里识别**未被现有 skill 覆盖**的可复用 pattern。判断后只输出一种结果：

**情况 A：找到 1 个值得沉淀的新 pattern** —— 严格按下述格式输出（不要任何前后缀解释）：

\`\`\`
DRAFT_BEGIN
---
name: <kebab-case 名字，<= 40 字符，不要和已有 skill 撞名>
description: <用户/任务出现何种特征时该激活；越精准越好；< 200 字>
---

# <Skill 中文名>

> 一句话说清楚解决什么问题、何时读

## 触发场景
- 3-5 条具体触发条件

## <核心内容章节>
（决策树 / 速查表 / 矩阵 / 案例 / 常见错误 + 正解）

## 边界
- ❌ 列 2-3 条不在范围内的事

## 来源
- 蒸馏自反思 sid: ${reflections.map(r => r.sid).join(', ')}
- 蒸馏日期：${new Date().toISOString().slice(0, 10)}
DRAFT_END
\`\`\`

**情况 B：没有显著 pattern / 反思都是已覆盖场景** —— 只输出一行：
\`\`\`
NO_PATTERN: <一句话说明原因>
\`\`\`

要求：
- 严格遵守上述输出格式，不要其它内容
- 如果 pattern 不强（< 3 个反思共有），优先 NO_PATTERN
- description 一定要写"何时激活"，不要写"这是个什么 skill"
- 不要重复已有 skill 的范围
- 输出长度上限 6000 字，超长会截断`;
}

type DistillResult =
  | { ok: true; draftId: string; name: string; sourceSids: string[] }
  | { ok: false; reason: string };

function parseDraftOutput(raw: string): { name: string; description: string; content: string } | null {
  const m = raw.match(/DRAFT_BEGIN\s*\n([\s\S]*?)\nDRAFT_END/);
  if (!m) return null;
  const body = m[1].trim();
  const fm = body.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1].trim();
  const description = fm[1].match(/^description:\s*(.+)$/m)?.[1].trim() ?? '';
  if (!name) return null;
  // sanity: kebab-case-ish & limit
  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  if (!safeName) return null;
  return { name: safeName, description: description.slice(0, 400), content: body };
}

/**
 * 跑一次蒸馏。
 * @param maxReflections 最多取多少条 pending（默认 12，太多 prompt 太长）
 * @returns DistillResult
 */
export async function runDistillation(maxReflections = 12): Promise<DistillResult> {
  const pendingSids = listBacklogByStatus('pending');
  if (pendingSids.length === 0) {
    return { ok: false, reason: 'No pending reflections.' };
  }

  // 拿出最多 maxReflections 条
  const targetSids = pendingSids.slice(0, maxReflections);
  const reflections: Array<{ sid: string; mode: string; title: string; body: string }> = [];
  for (const sid of targetSids) {
    const r = getReflection(sid);
    if (!r || !r.body.trim()) continue;
    reflections.push({
      sid,
      mode: r.mode,
      title: r.title.slice(0, 80),
      body: r.body.slice(0, 2500),
    });
  }
  if (reflections.length === 0) {
    return { ok: false, reason: 'No usable reflection bodies in pending backlog.' };
  }

  const skillIndex = loadSkillIndex();
  const prompt = buildDistillPrompt({ reflections, skillIndex });

  let response: string | null = null;
  try {
    response = await helper('reason', prompt, { maxTokens: 3500, temperature: 0.4 });
  } catch (err) {
    return { ok: false, reason: `helper LLM call failed: ${(err as Error).message}` };
  }
  if (!response || !response.trim()) {
    return { ok: false, reason: 'helper LLM returned empty response.' };
  }

  // 不论结果如何，所有用过的 sid 都标 distilled，避免下一轮重复跑
  const markDistilled = () => {
    const ts = new Date().toISOString();
    for (const sid of targetSids) {
      try {
        upsertBacklogItem(sid, 'distilled', ts);
      } catch { /* ignore */ }
    }
  };

  // NO_PATTERN 分支
  if (/^\s*NO_PATTERN/m.test(response)) {
    markDistilled();
    const reason = response.match(/^\s*NO_PATTERN:\s*(.+)$/m)?.[1].trim() ?? 'no pattern found';
    return { ok: false, reason: `NO_PATTERN: ${reason}` };
  }

  const parsed = parseDraftOutput(response);
  if (!parsed) {
    // 解析失败 —— 不 mark distilled（让下一轮重试，但下一轮可能换批反思）
    return {
      ok: false,
      reason: 'Failed to parse DRAFT_BEGIN/DRAFT_END from helper response.',
    };
  }

  const draftId = nanoid(12);
  try {
    createSkillDraft({
      id: draftId,
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      derived_from: targetSids,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to insert skill_draft: ${(err as Error).message}`,
    };
  }

  markDistilled();
  return { ok: true, draftId, name: parsed.name, sourceSids: targetSids };
}
