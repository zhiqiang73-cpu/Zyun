/**
 * 用户长记忆 (User Profile) — 跨 session 持久化的用户画像。
 *
 * 存储优先级：
 *   1. SQLite user_profile 表（key = 'main'）
 *   2. data/user_profile.json（向后兼容；首次读到自动迁入 SQLite）
 *
 * 注入：standard/heavy 任务的 system prompt 里嵌一段 < 2KB 的 profile 块。
 *       lite 任务不注入（保持轻量响应）。
 *
 * 写入：v0.1 用户手动编辑 user_profile.json（首次读取时自动迁入 SQLite）。
 *       v0.2 由 memory_writer subagent 自动维护（confidence > 0.85 自动 merge，
 *            其余进 user_facts 表等用户审核）。
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getStoredProfile, storeProfile } from './db';

const JSON_PROFILE_PATH =
  process.env.MANUSCOPY_PROFILE_PATH ??
  path.join(
    process.env.MANUSCOPY_DATA_DIR ?? path.join(process.cwd(), 'data'),
    'user_profile.json',
  );

export type CuttingStyle = 'conservative' | 'balanced' | 'aggressive';
export type Verbosity = 'low' | 'medium' | 'high';

export type UserFact = {
  id: string;
  text: string;
  source_sid?: string;
  ts?: string;
  /** 0-1，< 0.6 不会被注入 */
  confidence?: number;
  category?: 'preference' | 'machine' | 'constraint' | 'history' | 'vocabulary' | 'misc';
};

export type Machine = {
  type: string;          // FANUC / SIEMENS / HAAS / ...
  model?: string;        // Oi-MF / 828D / ...
  axes?: string;         // 'XYZ' / 'XYZA' / 'XYZBC'
  max_rpm?: number;
  spindle_kw?: number;
};

export type UserProfile = {
  version: number;
  updated_at: string;
  preferences?: {
    cutting_style?: CuttingStyle;
    preferred_tool_brands?: string[];
    language?: string;
    verbosity?: Verbosity;
  };
  machines?: Machine[];
  common_materials?: string[];
  constraints?: string[];
  vocabulary?: Record<string, string>;
  facts?: UserFact[];
};

/**
 * 读取用户档案。
 * 优先从 SQLite 读；若 SQLite 无记录则尝试读 JSON 文件并迁移入库。
 * 文件不存在 / 解析失败时返回 null。
 */
export function readProfile(): UserProfile | null {
  // 1. Try SQLite first
  try {
    const stored = getStoredProfile();
    if (stored) return stored as unknown as UserProfile;
  } catch (err) {
    console.warn('[user-profile] SQLite read failed, falling back to JSON:', err);
  }

  // 2. Fall back to JSON file (and migrate into SQLite)
  if (!existsSync(JSON_PROFILE_PATH)) return null;
  try {
    const raw = readFileSync(JSON_PROFILE_PATH, 'utf-8');
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return null;
    const profile = obj as UserProfile;

    // Auto-migrate into SQLite
    try {
      storeProfile(obj as Record<string, unknown>);
      console.log('[user-profile] Migrated user_profile.json → SQLite');
    } catch (err) {
      console.warn('[user-profile] SQLite migration failed (profile still usable):', err);
    }

    return profile;
  } catch (err) {
    console.warn('[user-profile] failed to read profile:', err);
    return null;
  }
}

/**
 * 把 profile 渲染成 < 2KB markdown 注入块。
 * lite 任务返回空字符串。
 */
export function renderProfileBlock(
  profile: UserProfile | null,
  taskMode: 'lite' | 'standard' | 'heavy',
): string {
  if (!profile || taskMode === 'lite') return '';

  const sections: string[] = [];

  // ---- 偏好 ----
  if (profile.preferences) {
    const p = profile.preferences;
    const items: string[] = [];
    if (p.cutting_style) {
      const styleLabel: Record<CuttingStyle, string> = {
        conservative: '保守（小切深 + 多刀路）',
        balanced: '均衡',
        aggressive: '激进（大切深 + 快进给）',
      };
      items.push(`切削风格：${styleLabel[p.cutting_style]}`);
    }
    if (p.preferred_tool_brands?.length) {
      items.push(`常用刀具品牌：${p.preferred_tool_brands.join('、')}`);
    }
    if (p.language) items.push(`沟通语言：${p.language}`);
    if (p.verbosity) {
      const vLabel: Record<Verbosity, string> = { low: '简短', medium: '适中', high: '详细' };
      items.push(`回答详细度：${vLabel[p.verbosity]}`);
    }
    if (items.length) sections.push('### 偏好\n' + items.map(s => `- ${s}`).join('\n'));
  }

  // ---- 机床 ----
  if (profile.machines?.length) {
    const lines = profile.machines.map(m => {
      const head = m.model ? `${m.type} ${m.model}` : m.type;
      const tail: string[] = [];
      if (m.axes) tail.push(m.axes);
      if (m.max_rpm) tail.push(`${m.max_rpm} rpm`);
      if (m.spindle_kw) tail.push(`${m.spindle_kw} kW`);
      return tail.length ? `- ${head}（${tail.join('，')}）` : `- ${head}`;
    });
    sections.push('### 机床\n' + lines.join('\n'));
  }

  // ---- 常用材料 ----
  if (profile.common_materials?.length) {
    sections.push(`### 常用材料\n${profile.common_materials.join('、')}`);
  }

  // ---- 工艺约束 ----
  if (profile.constraints?.length) {
    sections.push('### 工艺约束\n' + profile.constraints.map(c => `- ${c}`).join('\n'));
  }

  // ---- 用户术语 ----
  if (profile.vocabulary && Object.keys(profile.vocabulary).length) {
    sections.push(
      '### 用户术语习惯\n' +
        Object.entries(profile.vocabulary)
          .map(([k, v]) => `- "${k}" 用户习惯叫 "${v}"`)
          .join('\n'),
    );
  }

  // ---- facts（confidence ≥ 0.6 的前 5 条）----
  if (profile.facts?.length) {
    const facts = [...profile.facts]
      .filter(f => (f.confidence ?? 1) >= 0.6)
      .sort((a, b) => (b.confidence ?? 1) - (a.confidence ?? 1))
      .slice(0, 5);
    if (facts.length) {
      sections.push('### 历史观察\n' + facts.map(f => `- ${f.text}`).join('\n'));
    }
  }

  if (!sections.length) return '';

  let block =
    '\n## 用户档案（持续记忆）\n\n' +
    '以下是从历史任务累积的用户画像。**做技术决策时优先采用用户既定偏好**，' +
    '不要替用户决定他还没决定的事；如果新决策与画像冲突，先简短指出再请求确认。\n\n' +
    sections.join('\n\n') +
    '\n';

  // 硬限 2KB
  if (block.length > 2000) {
    block = block.slice(0, 2000) + '\n…(profile 已截断)\n';
  }
  return block;
}

/** 暴露 profile JSON 路径，便于 UI / 调试工具引用（兼容旧代码）。 */
export function getProfilePath(): string {
  return JSON_PROFILE_PATH;
}
