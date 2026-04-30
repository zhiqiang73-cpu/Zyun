/**
 * Task Classifier (Meta-Orchestrator) —— 给任务分级别
 *
 * 灵感：Manus 的 taskModeChanged 事件（lite / standard / heavy）。
 * 每个任务进入前先用一个轻量 helper LLM 判定难度，按级别走不同路径：
 *
 *   lite     —— Claude Haiku 4.5 + 精简 system prompt（不强制 process-planning skill）
 *                适用：简单问答 / 单一计算 / 短代码
 *   standard —— Claude Sonnet 4.5 + 完整领域 workflow
 *                适用：图纸→G-code、网站/网页/工具生成、文档处理、多步任务
 *   heavy    —— Claude Sonnet 4.5 + 多 helper 并行 + 强制 critic 审查
 *                适用：多图纸/PLC+CNC/复杂工艺/高精度件、多页面复杂 Web app
 *
 * 速度收益：lite 模式响应 < 5s；standard 30-60s；heavy 1-3min（带 critic）
 */

import { helper } from './helper-llm';

export type TaskMode = 'lite' | 'standard' | 'heavy';
export type ClassifyContext = 'initial' | 'followup';

export type ClassifyResult = {
  mode: TaskMode;
  reason: string;
  recommendedModel: string;
  forceCritic: boolean;
};

// 默认模型映射
const MODEL_BY_MODE: Record<TaskMode, string> = {
  lite: process.env.MANUSCOPY_LITE_MODEL ?? 'claude-haiku-4-5',
  standard:
    process.env.MANUSCOPY_MODEL ??
    process.env.MANUSCOPY_CLAUDE_CODE_MODEL ??
    'claude-sonnet-4-5',
  heavy:
    process.env.MANUSCOPY_HEAVY_MODEL ??
    process.env.MANUSCOPY_MODEL ??
    process.env.MANUSCOPY_CLAUDE_CODE_MODEL ??
    'claude-sonnet-4-5',
};

const FOLLOWUP_MARKER = '## 用户的新指令（本轮要做的事）：';
const LITE_BIAS_ENABLED = process.env.MANUSCOPY_CLASSIFY_LITE_BIAS === '1';

function normalizePromptForClassify(prompt: string, context: ClassifyContext): string {
  if (context !== 'followup') return prompt;
  const i = prompt.lastIndexOf(FOLLOWUP_MARKER);
  if (i < 0) return prompt;
  const tail = prompt.slice(i + FOLLOWUP_MARKER.length).trim();
  return tail || prompt;
}

/**
 * 启发式分类（无需调 LLM 的快速路径）。
 * 决策原则：
 *   1. 先看是否是【问答】模式（"什么是""区别""为什么"等），无论技术词汇 → LITE
 *   2. 再看是否有【动作】词（生成/写/做/制定）→ STANDARD/HEAVY
 *   3. 兜底逻辑
 */
function heuristicClassify(
  prompt: string,
  attachmentNames: string[],
  context: ClassifyContext = 'initial',
): ClassifyResult | null {
  const classifyPrompt = normalizePromptForClassify(prompt, context);
  const p = classifyPrompt.toLowerCase();
  const hasFiles = attachmentNames.length > 0;
  const promptLen = classifyPrompt.length;

  // ⭐ 知识吸纳模式（用户明确要把文档"教给系统"/"整合 skill"）
  // 这类任务必走 standard，必读 skill-creator
  const ingestPatterns = [
    /(?:整合|教给|喂给|添加到|加入).{0,15}(?:系统|skill|知识库|手册)/,
    /(?:学[习一]+下|吸收|沉淀).{0,15}(?:这[个本份]|此).{0,15}(?:pdf|文档|资料|书|手册|标准)/,
    /(?:把|将).{0,30}(?:distill|提炼|整合|做成).{0,15}(?:skill|手册|规则)/,
    /(?:做一个|新建).{0,15}(?:skill|技能|手册).{0,30}(?:领域|方面)/,
    /distill.{0,15}(?:pdf|doc|skill)/i,
  ];
  if (ingestPatterns.some(re => re.test(classifyPrompt))) {
    return {
      mode: 'standard',
      reason: '知识吸纳任务：触发 skill-creator 流水线',
      recommendedModel: MODEL_BY_MODE.standard,
      forceCritic: false,
    };
  }

  // 问答模式（即使含技术词也判 lite）
  const qaPatterns = [
    /什么是|什么叫|是什么/,
    /(.+?)(?:和|与|跟|对|vs)(.+?)(?:的)?(?:区别|差别|不同|对比)/,
    /为什么|为啥/,
    /(?:怎么|如何)(?:理解|看待|区分|分辨|判断|定义)/,
    /(?:可以|能否|是否)?(?:请)?(?:简单)?(?:列举|罗列|总结|概述|科普|讲讲)/,
    /(?:有哪些|有哪几种|常见的|优缺点|适用场景|原理|公式|特点|注意事项)/,
    /(?:解释|介绍|说明|阐述)(?!.*?(?:生成|写|做|创建|制定|输出))/,
    /^(?:什么|哪|怎|如何|这是)/,
    /有何(?:不同|区别|差异)/,
    /(?:含义|定义|意思)(?:是什么)?/,
  ];
  const isQaPattern = qaPatterns.some(re => re.test(classifyPrompt));

  const webBuildPatterns = [
    /(?:做|建|搭|写|生成|创建|设计|开发).{0,12}(?:网站|网页|官网|落地页|landing\s?page|portfolio|作品集|博客|商城|仪表盘|dashboard|后台|管理系统|小工具|小游戏|web\s?app|app)/i,
    /(?:html|css|javascript|typescript|react|next\.?js|tailwind|前端|页面|组件).{0,18}(?:做|建|写|生成|创建|设计|开发|实现)/i,
    /(?:做|建|写|生成|创建|设计|开发|实现).{0,18}(?:html|css|javascript|typescript|react|next\.?js|tailwind|前端|页面|组件)/i,
  ];
  const isWebBuild = webBuildPatterns.some(re => re.test(classifyPrompt));

  // 动作词（明确要求"做事"，不只是"问"）
  const actionVerbs = /(?:生成|创建|写一?(?:段|个|份)|做一?个|制定|画|设计|开发|实现|搭建|输出.*代码|出.*?代码|批量|加工出|处理.*文件|提取.*?(?:特征|尺寸|信息).*?(?:并|然后))/;
  const isAction = actionVerbs.test(classifyPrompt);

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
  if (promptLen < 160 && !hasFiles && !isAction) {
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
    '后台', '管理系统', 'dashboard', '仪表盘', '登录', '权限',
    '多页面', '路由', '数据库', '支付', 'saas', '图表', '拖拽',
  ];
  const heavyHits = heavyKeywords.filter(k => p.includes(k)).length;
  const manyAttachments = attachmentNames.length >= 3;
  const multiCodeOutput = /(?:plc|s7|梯形图).*(?:g.?code|nc|fanuc)|(?:g.?code|nc|fanuc).*(?:plc|s7|梯形图)/i.test(classifyPrompt);
  const complexWebOutput = isWebBuild && heavyHits >= 2;

  if (heavyHits >= 2 || manyAttachments || multiCodeOutput || complexWebOutput) {
    return {
      mode: 'heavy',
      reason: `复杂任务：${heavyHits} 复杂词 / ${attachmentNames.length} 附件 / 多代码联动=${multiCodeOutput}`,
      recommendedModel: MODEL_BY_MODE.heavy,
      forceCritic: true,
    };
  }

  // ---- STANDARD ----
  if (hasFiles || isAction || isWebBuild) {
    return {
      mode: 'standard',
      reason: hasFiles ? '有附件文件' : isWebBuild ? '网站/前端产物生成任务' : '含动作词（要生成/创建）',
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
async function llmClassify(
  prompt: string,
  attachmentNames: string[],
  context: ClassifyContext = 'initial',
): Promise<ClassifyResult> {
  const classifyPrompt = normalizePromptForClassify(prompt, context);
  const judgePrompt = `你是任务难度分类器。判断以下任务的处理难度（lite / standard / heavy）。

任务描述：
"""
${classifyPrompt.slice(0, 800)}
"""

附件：${attachmentNames.length === 0 ? '无' : attachmentNames.join('、')}

判定标准：
- lite：纯解释/对比/概念问答（即使提到 CNC/G-code/PLC）、简单计算、短代码问答；通常无附件且不要求生成产物
- standard：需要生成具体产物（文件/代码/方案）或处理附件（如 PDF 图纸、网站/网页/前端页面）、多步但流程清晰
- heavy：复杂工艺（PLC + CNC 联动）/ 多页图纸 / 高精度（H6 H7 严格）/ 多代码语言混合 / 多页面复杂 Web app

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

  if (LITE_BIAS_ENABLED) {
    const likelyAction = /(?:生成|创建|写一?(?:段|个|份)|做一?个|制定|画|设计|开发|实现|搭建|输出.*代码|出.*?代码|批量|加工出|处理.*文件|网站|网页|前端|html|react|next\.?js|tailwind)/i.test(classifyPrompt);
    if (attachmentNames.length === 0 && !likelyAction) {
      return {
        mode: 'lite',
        reason: 'lite bias: 无附件且非动作产出',
        recommendedModel: MODEL_BY_MODE.lite,
        forceCritic: false,
      };
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
  context: ClassifyContext = 'initial',
): Promise<ClassifyResult> {
  const heuristic = heuristicClassify(prompt, attachmentNames, context);
  if (heuristic) return heuristic;
  return await llmClassify(prompt, attachmentNames, context);
}
