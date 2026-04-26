/**
 * Task Classifier (Meta-Orchestrator) —— 给任务分级别
 *
 * 灵感：Manus 的 taskModeChanged 事件（lite / standard / heavy）。
 * 每个任务进入前先用一个轻量 helper LLM 判定难度，按级别走不同路径：
 *
 *   lite     —— Claude Haiku 4.5 + 精简 system prompt（不强制 process-planning skill）
 *                适用：简单问答 / 单一计算 / 短代码
 *   standard —— Claude Sonnet 4.5 + 完整工艺手册流程
 *                适用：图纸→G-code、文档处理、多步任务
 *   heavy    —— Claude Sonnet 4.5 + 多 helper 并行 + 强制 critic 审查
 *                适用：多图纸/PLC+CNC/复杂工艺/高精度件
 *
 * 速度收益：lite 模式响应 < 5s；standard 30-60s；heavy 1-3min（带 critic）
 */

import { helper } from './helper-llm';

export type TaskMode = 'lite' | 'standard' | 'heavy';

export type ClassifyResult = {
  mode: TaskMode;
  reason: string;
  recommendedModel: string;
  forceCritic: boolean;
};

// 默认模型映射
const MODEL_BY_MODE: Record<TaskMode, string> = {
  lite: process.env.MANUSCOPY_LITE_MODEL ?? 'claude-haiku-4-5',
  standard: process.env.MANUSCOPY_MODEL ?? 'claude-sonnet-4-5',
  heavy: process.env.MANUSCOPY_HEAVY_MODEL ?? process.env.MANUSCOPY_MODEL ?? 'claude-sonnet-4-5',
};

/**
 * 启发式分类（无需调 LLM 的快速路径）。
 * 决策原则：
 *   1. 先看是否是【问答】模式（"什么是""区别""为什么"等），无论技术词汇 → LITE
 *   2. 再看是否有【动作】词（生成/写/做/制定）→ STANDARD/HEAVY
 *   3. 兜底逻辑
 */
function heuristicClassify(prompt: string, attachmentNames: string[]): ClassifyResult | null {
  const p = prompt.toLowerCase();
  const hasFiles = attachmentNames.length > 0;
  const promptLen = prompt.length;

  // 问答模式（即使含技术词也判 lite）
  const qaPatterns = [
    /什么是|什么叫|是什么/,
    /(.+?)(?:和|与|跟|对|vs)(.+?)(?:的)?(?:区别|差别|不同|对比)/,
    /为什么|为啥/,
    /(?:怎么|如何)(?:理解|看待|区分|分辨|判断|定义)/,
    /(?:解释|介绍|说明|阐述)(?!.*?(?:生成|写|做|创建|制定|输出))/,
    /^(?:什么|哪|怎|如何|这是)/,
    /有何(?:不同|区别|差异)/,
    /(?:含义|定义|意思)(?:是什么)?/,
  ];
  const isQaPattern = qaPatterns.some(re => re.test(prompt));

  // 动作词（明确要求"做事"，不只是"问"）
  const actionVerbs = /(?:生成|创建|写一?(?:段|个|份)|做一?个|制定|画|设计|输出.*代码|出.*?代码|批量|加工出|处理.*文件|提取.*?(?:特征|尺寸|信息).*?(?:并|然后))/;
  const isAction = actionVerbs.test(prompt);

  // ---- LITE ----（最优先）
  // 问答模式 + 无附件 + 不是动作要求 → 必 lite，即使含 G-code/铣/钻等技术词
  if (isQaPattern && !hasFiles && !isAction && promptLen < 300) {
    return {
      mode: 'lite',
      reason: '问答模式（技术词汇属知识询问，非任务）',
      recommendedModel: MODEL_BY_MODE.lite,
      forceCritic: false,
    };
  }

  // 短文本 + 无附件 + 无动作词 → lite
  if (promptLen < 80 && !hasFiles && !isAction) {
    return {
      mode: 'lite',
      reason: '短文本无附件无动作词',
      recommendedModel: MODEL_BY_MODE.lite,
      forceCritic: false,
    };
  }

  // ---- HEAVY ----
  const heavyKeywords = [
    'plc', 'cnc', '联动', '多轴', '多页',
    '高精度', 'h6', 'h7/g6', '装配',
    '复杂工艺', '批量生产', '量产', '大批量',
  ];
  const heavyHits = heavyKeywords.filter(k => p.includes(k)).length;
  const manyAttachments = attachmentNames.length >= 3;
  const multiCodeOutput = /(?:plc|s7|梯形图).*(?:g.?code|nc|fanuc)|(?:g.?code|nc|fanuc).*(?:plc|s7|梯形图)/i.test(prompt);

  if (heavyHits >= 2 || manyAttachments || multiCodeOutput) {
    return {
      mode: 'heavy',
      reason: `复杂任务：${heavyHits} 复杂词 / ${attachmentNames.length} 附件 / 多代码联动=${multiCodeOutput}`,
      recommendedModel: MODEL_BY_MODE.heavy,
      forceCritic: true,
    };
  }

  // ---- STANDARD ----
  if (hasFiles || isAction) {
    return {
      mode: 'standard',
      reason: hasFiles ? '有附件文件' : '含动作词（要生成/创建）',
      recommendedModel: MODEL_BY_MODE.standard,
      forceCritic: false,
    };
  }

  return null; // 让 LLM 兜底
}

/**
 * LLM 兜底分类（启发式无法判断时调用）
 * 用 verify helper（DeepSeek-V3，便宜+快），输出结构化 JSON。
 */
async function llmClassify(prompt: string, attachmentNames: string[]): Promise<ClassifyResult> {
  const judgePrompt = `你是任务难度分类器。判断以下任务的处理难度（lite / standard / heavy）。

任务描述：
"""
${prompt.slice(0, 800)}
"""

附件：${attachmentNames.length === 0 ? '无' : attachmentNames.join('、')}

判定标准：
- lite：单步问答 / 简单计算 / 短代码 / 不涉及机加工 / 无附件
- standard：标准 2D 铣削 / 单图纸生成 G-code / 文档处理 / 多步但流程清晰
- heavy：复杂工艺（PLC + CNC 联动）/ 多页图纸 / 高精度（H6 H7 严格）/ 多代码语言混合

只输出 JSON（不要其他文字）：
{"mode": "lite|standard|heavy", "reason": "20 字以内"}`;

  const resp = await helper('verify', judgePrompt, {
    maxTokens: 200,
    temperature: 0.1,
  });

  // 解析；失败则默认 standard 兜底
  if (resp) {
    const m = resp.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        const mode = (['lite', 'standard', 'heavy'] as const).includes(parsed.mode)
          ? (parsed.mode as TaskMode)
          : 'standard';
        return {
          mode,
          reason: String(parsed.reason || '').slice(0, 100),
          recommendedModel: MODEL_BY_MODE[mode],
          forceCritic: mode === 'heavy',
        };
      } catch {}
    }
  }

  return {
    mode: 'standard',
    reason: 'LLM 分类失败，默认 standard',
    recommendedModel: MODEL_BY_MODE.standard,
    forceCritic: false,
  };
}

/**
 * 主入口：先启发式，再 LLM 兜底。
 * 启发式命中时 < 1ms，LLM 调用约 1-2 秒。
 */
export async function classifyTask(
  prompt: string,
  attachmentNames: string[] = [],
): Promise<ClassifyResult> {
  const heuristic = heuristicClassify(prompt, attachmentNames);
  if (heuristic) return heuristic;
  return await llmClassify(prompt, attachmentNames);
}
