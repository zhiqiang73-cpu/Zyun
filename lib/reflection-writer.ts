/**
 * Reflection Writer — 任务结束后给"自学习闭环"攒原料。
 *
 * 设计：
 *   - 每个 standard/heavy 任务结束（含 error 失败）后异步跑一次反思
 *   - 4 问 prompt（盲区 / 命中 skill / 可复用 pattern / 改进建议）
 *   - 输出：SQLite reflections 表 + learning_backlog 表
 *   - lite 任务跳过（成本/价值不匹配）
 *
 * 后续 Step 4 会做：累积 N 条或一周到了 → 批量蒸馏成 skill draft。
 * 当前 Step 3 只攒，不蒸馏。
 *
 * 模型：helper('verify')，DeepSeek-V3 便宜模型够用。每次 ~¥0.005。
 */

import { listAllEvents, upsertReflection, upsertBacklogItem, getBacklogItem, listBacklogByStatus } from './db';
import { helper } from './helper-llm';
import type { TaskMode } from './task-classifier';

type EventSummary = {
  userPrompt: string;
  planSteps: string[];
  toolCount: number;
  keyTools: string[];
  finalStatus: string;
  durationS: number;
  assistantTail: string;
};

function summarizeEvents(sid: string): EventSummary {
  const blank: EventSummary = {
    userPrompt: '',
    planSteps: [],
    toolCount: 0,
    keyTools: [],
    finalStatus: 'unknown',
    durationS: 0,
    assistantTail: '',
  };
  const events = listAllEvents(sid);
  if (!events.length) return blank;

  const userEvent = events.find(e => e.type === 'chat' && e.sender === 'user');
  const userPrompt = (userEvent?.content ?? '').slice(0, 800);
  const planSteps: string[] = [];
  const toolBriefs: string[] = [];
  let finalStatus = 'unknown';
  const tStart = events[0].timestamp;
  let tEnd = events[0].timestamp;
  const assistantChunks: string[] = [];

  for (const e of events) {
    if (e.timestamp > tEnd) tEnd = e.timestamp;
    if (e.type === 'planUpdate') {
      const tasks = (e.payload as Record<string, unknown>)?.tasks;
      if (Array.isArray(tasks)) {
        planSteps.length = 0;
        for (const t of tasks) {
          if ((t as Record<string, unknown>)?.title)
            planSteps.push(String((t as Record<string, unknown>).title));
        }
      }
    }
    if (e.type === 'toolUsed') {
      const action = e.toolAction ?? '';
      const briefStr = e.brief ? ': ' + e.brief : '';
      const tool = e.tool ?? '?';
      toolBriefs.push(`${tool}/${action}${briefStr}`.slice(0, 120));
    }
    if (e.type === 'statusUpdate') {
      const s = (e.payload as Record<string, unknown>)?.agentStatus;
      if (typeof s === 'string') finalStatus = s;
    }
    if (e.type === 'chat' && e.sender === 'assistant' && e.content) {
      assistantChunks.push(e.content);
    }
  }

  const last = assistantChunks[assistantChunks.length - 1] ?? '';
  const assistantTail = last.length > 1500 ? last.slice(0, 1500) + '…' : last;

  return {
    userPrompt,
    planSteps,
    toolCount: toolBriefs.length,
    keyTools: toolBriefs.slice(0, 20),
    finalStatus,
    durationS: Math.round((tEnd - tStart) / 1000),
    assistantTail,
  };
}

function buildReflectionPrompt(
  taskMode: TaskMode,
  taskTitle: string,
  s: EventSummary,
): string {
  const planLine = s.planSteps.length
    ? s.planSteps.map((t, i) => `  ${i + 1}. ${t}`).join('\n')
    : '  (无 plan)';
  const toolLine = s.keyTools.length
    ? s.keyTools.map(t => '  - ' + t).join('\n')
    : '  (无)';
  return `你是任务反思助理。读完以下任务记录，回答 4 问。

## 任务摘要
- 模式：${taskMode}
- 标题：${taskTitle}
- 用户原始 prompt：${s.userPrompt}
- 最终状态：${s.finalStatus}
- 持续：${s.durationS}s
- 工具调用数：${s.toolCount}

### Plan steps
${planLine}

### 关键工具调用（最多 20 条）
${toolLine}

### Assistant 最终输出片段
${s.assistantTail || '(无)'}

## 4 问

回答时严格遵守：
- **只引用任务实际发生的事**，不编、不臆测；没把握就答 "无"
- 每问 < 100 字
- 输出 markdown，4 个二级标题（## Q1 / ## Q2 / ## Q3 / ## Q4），不要其它内容

Q1：这个任务遇到什么新挑战？哪些情况是现有 skill 没覆盖的盲区？
Q2：哪个 skill 真正帮上忙？哪个看了等于没看（或根本没读）？
Q3：解法里有没有可复用的 pattern（适用于未来同类任务）？
Q4：下次类似任务怎么走更快、更准？给一条具体建议。`;
}

/**
 * 任务后反思——异步、fire-and-forget、错误吞掉。
 * lite 任务直接跳过。
 */
export async function runReflection(
  sid: string,
  taskMode: TaskMode,
  taskTitle: string,
): Promise<void> {
  if (taskMode === 'lite') return;

  let summary: EventSummary;
  try {
    summary = summarizeEvents(sid);
  } catch (err) {
    console.warn('[reflection-writer] summarize failed:', err);
    return;
  }
  if (!summary.userPrompt) return;

  const prompt = buildReflectionPrompt(taskMode, taskTitle, summary);

  let reflection: string | null = null;
  try {
    reflection = await helper('verify', prompt, {
      maxTokens: 800,
      temperature: 0.3,
      progress: { sessionId: sid, label: '生成任务反思' },
    });
  } catch (err) {
    console.warn('[reflection-writer] helper failed:', err);
    return;
  }
  if (!reflection || !reflection.trim()) return;

  const ts = new Date().toISOString();
  const safeTitle = taskTitle.replace(/[\r\n"]/g, ' ').slice(0, 100);

  try {
    upsertReflection({
      sid,
      ts,
      mode: taskMode,
      title: safeTitle,
      duration_s: summary.durationS,
      tool_count: summary.toolCount,
      final_status: summary.finalStatus,
      body: reflection.trim(),
    });
  } catch (err) {
    console.warn('[reflection-writer] db write failed:', err);
    return;
  }

  // Add to backlog if not already tracked
  const existing = getBacklogItem(sid);
  if (!existing || existing.status === 'pending') {
    try {
      upsertBacklogItem(sid, 'pending');
    } catch (err) {
      console.warn('[reflection-writer] backlog update failed:', err);
    }
  }

  const pendingCount = listBacklogByStatus('pending').length;

  console.log(
    `[manuscopy] reflection saved: ${sid} (backlog pending=${pendingCount})`,
  );
}
