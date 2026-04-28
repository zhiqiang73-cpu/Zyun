import { NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { getSession, appendEvent, listAllEvents, updateSession } from '@/lib/db';
import { runAgent } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/tasks/[id]/messages
 * body: { content: string }
 *
 * 用户中途/任务结束后追加消息。逻辑：
 *   1. 校验 session 存在；running / queued 时把消息记为运行中插话
 *   2. 把新消息作为 chat event (sender=user) 写入
 *   3. 构造一个"接续上一轮"的 prompt：包含先前对话摘要 + 新消息
 *   4. 启动新一轮 runAgent（共用同 session id，事件继续追加）
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = getSession(params.id);
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const content = String(body?.content ?? '').trim();
  if (!content) {
    return NextResponse.json({ error: 'content is required' }, { status: 400 });
  }
  const isRunning = session.status === 'running' || session.status === 'queued';

  // 1. 写入 user 消息事件
  appendEvent({
    id: nanoid(22),
    sessionId: params.id,
    type: 'chat',
    timestamp: Date.now(),
    sender: 'user',
    content,
    payload: isRunning ? { intervention: true, duringStatus: session.status } : undefined,
  });

  if (isRunning) {
    appendEvent({
      id: nanoid(22),
      sessionId: params.id,
      type: 'liveStatus',
      timestamp: Date.now(),
      payload: {
        state: 'user_intervention',
        content,
        duringStatus: session.status,
      },
    });
    return NextResponse.json({ ok: true, queued: true });
  }

  // 2. 构造接续 prompt：摘要先前对话 + 新消息
  const prior = listAllEvents(params.id);
  const userMsgs = prior
    .filter(e => e.type === 'chat' && e.sender === 'user' && !(e.payload as any)?.intervention && e.content)
    .map(e => e.content as string);
  const lastAssistantMsg = [...prior]
    .reverse()
    .find(e => e.type === 'chat' && e.sender === 'assistant')?.content;

  // 摘要：列出之前所有 user 消息（除了刚加的这条）+ 助手的最后一条总结
  const prevUserMsgs = userMsgs.slice(0, -1);
  const pendingInterventions = prior
    .filter(e => e.type === 'chat' && e.sender === 'user' && (e.payload as any)?.intervention && e.content)
    .map(e => e.content as string);
  let summary = '';
  if (pendingInterventions.length > 0 || prevUserMsgs.length > 0 || lastAssistantMsg) {
    const lines: string[] = ['[这是当前任务的接续轮，不是新任务]\n'];
    if (pendingInterventions.length > 0) {
      lines.push('## 用户在上一轮运行中追加的约束（优先遵守）：');
      pendingInterventions.forEach((m, i) => lines.push(`${i + 1}. ${m.slice(0, 300)}`));
      lines.push('');
    }
    if (prevUserMsgs.length > 0) {
      lines.push('## 用户之前说过：');
      prevUserMsgs.forEach((m, i) => lines.push(`${i + 1}. ${m.slice(0, 300)}`));
      lines.push('');
    }
    if (lastAssistantMsg) {
      lines.push('## 你（助手）上一轮的总结：');
      lines.push(lastAssistantMsg.slice(0, 600));
      lines.push('');
    }
    lines.push('## 工作区状态：');
    lines.push('当前目录里已经有上一轮生成的文件，先用 `ls` + `Read` 关键文件了解状态再决定下一步动作。');
    lines.push('');
    summary = lines.join('\n');
  }

  const fullPrompt = summary + '## 用户的新指令（本轮要做的事）：\n' + content;

  // 3. 启动新一轮 agent（异步，不 await）
  void runAgent(params.id, fullPrompt, { context: 'followup' }).catch(err => {
    console.error('[manuscopy] follow-up run failed', params.id, err);
  });

  // 立刻把 session 状态推回 running，让前端立即显示"思考中"
  updateSession(params.id, { status: 'running' });

  return NextResponse.json({ ok: true });
}
