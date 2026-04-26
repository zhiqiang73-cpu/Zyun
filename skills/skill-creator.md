---
name: skill-creator
description: 元技能 / 知识沉淀流水线。当用户上传专业 PDF / 教科书 / 标准 / catalog / 经验文档要"教给系统"或"整合进 skill"时启用。指导 agent 按 7 步方法论自动 distill，按"知识分层规则"决定每块内容落到 skill / data / script 哪一层，输出 Anthropic 标准格式 skill 草稿到 workspace/skills/，由用户审核后 promote 到项目级。
---

# Skill Creator —— 自动把领域知识变成 LLM 能复用的 skill

> **核心理念**：人手动 distill 不可扩展。每次有新文档，agent 应该自己**判断 → 抽取 → 分层 → 输出**，让用户只做最后审核。

## 触发场景（任一即激活）

- 用户说"把这份 PDF 整合到系统 / 教给系统 / 让 Manuscopy 学一下"
- 用户上传文档 + 暗示要让未来类似任务都受益
- 任务跑完发现某类问题没有现成 skill 可以指导，该提议沉淀
- 用户说"再加一个 X 领域的 skill"

## 启动前先 ls skills/

每次开始前先 **`ls skills/`** 看现有库，避免：
- 重复创建已有概念的 skill
- 错过应该补到现有 skill 而不是新建的内容

当前 skills/ 库（截至本文件创建时）：
```
2d-milling-workflow.md     2D 铣削主流程编排
drawing-recognition.md     识图扫描清单（vision helper 自动注入）
process-planning.md        工艺路线决策手册
process-cases.md           5 个真实工艺过程卡案例库
machining-handbook.md      切削参数索引手册
gcode-fanuc.md             FANUC G-code 编写规约
critic-checklist.md        独立质检清单
read-2d-drawing.md         传统识图基础
skill-creator.md           本文件
```

## 7 步方法论

### Step 1：内容定位（搞清楚这是什么）

读完文档前几页 + 标题 + 目录，回答：
- **域**：机加工 / 电气 / 传感器 / 工艺 / PLC / 管理 / 安全 / ...
- **类型**：方法论书 / 标准规范（GB/IEC/ISO）/ 厂家 catalog / 案例库 / 公式手册 / 经验总结 / 教科书 / 操作手册
- **抽象程度**：通用知识 / 专业规则 / 具体型号数据
- **可信度**：国标 > 厂家手册 > 教科书 > 经验文章 > 自媒体

写一个 `_meta` 段（最后会嵌到 skill 里）记录来源，便于追溯。

### Step 2：抽提取（用 PyMuPDF）

```bash
python scripts/distill_doc.py <pdf_path> --out parsed/
```

脚本会输出：
- `parsed/full_text.txt` — 全文文字
- `parsed/structure.json` — 章节树（基于字号/缩进识别）
- `parsed/page_<N>.png` — 关键页渲染图（如果含图表）

**或退化到手工**：用 Read 读全文，自己整理章节树。

### Step 3：⭐ 知识分层（**最关键的一步**）

**不要把所有内容都塞进 .md**！按以下规则分流：

| 内容类型 | 落到哪层 | 文件类型 | 例子 |
|---|---|---|---|
| **决策树 / 流程 / 5 大原则** | skill | `.md` | "5 大工序顺序" / "识图扫描清单" |
| **数值表 / 规格 / 矩阵** | data | `.json` | 切削参数表 / 公差等级表 / 螺纹规格 |
| **确定性计算（公式 + 公式 + 公式）** | script | `.py` | feeds/speeds 计算器 / G-code 校验器 |
| **案例 / 实例 / 范本** | skill | `.md`（独立案例库）| 工艺过程卡案例 |
| **校验清单 / 审查规则** | skill | `.md` | critic-checklist |
| **视觉/格式识别规则** | skill | `.md` | 识图符号字典 |
| **关于"何时用什么"的经验** | skill | `.md` | 工艺路线决策手册 |

**判断决策树**：
```
这个内容是不是数字？
  └─ YES → 是不是表格？
       └─ YES → JSON 数据 (knowledge/<name>.json)
       └─ NO  → 是不是公式？
              └─ YES → 写脚本 (scripts/<name>.py)
              └─ NO  → 写到 skill 里 ".md"
  └─ NO → 是不是流程/决策/规则？
       └─ YES → skill .md
       └─ NO → 是不是范本/案例？
            └─ YES → 案例库 .md
            └─ NO → ⚠️ 也许这内容没必要 distill
```

**反模式**：把厚厚一本 catalog 全塞进 .md（太长 LLM 读得慢，反而比查表慢）

### Step 4：写 skill markdown 文件

**位置**：`workspace/skills/<name>.md`（先放 workspace，由用户审核 promote 到项目级）

**强制 frontmatter**：
```yaml
---
name: <kebab-case-name>
description: <用户/任务出现何种特征时该激活；越精准越好；< 200 字>
---
```

**模板（按需用）**：
```markdown
# <Skill 名称>

> 一句话说清楚这 skill 解决什么问题，谁该读，何时读

## 触发场景
- 列出 3-5 条具体触发条件

## <核心内容章节>
- 公式速查表（如有公式）
- 决策树（如有分支）
- 数据库索引（如配套 JSON 数据）
- 速查表 / 矩阵
- 实战案例（2-3 个）
- 常见错误 + 正解
- 边界（什么不在范围内）
- 输出格式（如果要求结构化输出）

## 输出格式
（如果 skill 要求 agent 输出结构化结果，给 JSON schema）

## 关联 skill
- 引用相关已有 skill（cross-link）

## 来源
- 原始 PDF / 标准号 / 链接
- distill 日期
```

**长度控制**：
- 单 skill < 20KB / < 6000 字
- 超长 → 拆成"主 skill + 案例库 skill"（参考 process-planning.md + process-cases.md）

### Step 5：写关联数据/脚本（如果 Step 3 判定要写）

**JSON 数据**：放 `workspace/knowledge/<name>.json`
- 顶部加 `_doc` 字段说明用途
- 用 `_units` / `_lookup_keys` 等元字段帮助 agent 理解结构

**Python 脚本**：放 `workspace/scripts/<name>.py`
- 强制 UTF-8 stdout（防 Windows GBK 乱码）
- 加 `--list-*` 发现命令（用户能用 --help 查到能力）
- 支持 `--out result.json` 落盘
- 输入校验 + 友好错误信息
- 不依赖项目级路径（用 `Path(__file__).resolve().parent` 推断）

### Step 6：建关联（让新 skill 不孤立）

- 在新 skill 里 cross-link 现有相关 skill（"参见 skills/X.md §Y"）
- 如果新 skill 是某个工作流的环节，去对应 workflow skill 里加一段引用
- 在 `2d-milling-workflow.md`（或对应主 workflow）里加 step：何时调用本 skill

### Step 7：交付 + 验证

输出给用户的清单：
```
draft skill 已生成：
  - workspace/skills/<name>.md       (~ X KB)
  - workspace/knowledge/<name>.json  (~ Y KB) (如有)
  - workspace/scripts/<name>.py      (~ Z KB) (如有)

要正式启用，请：
1. 检查上述文件的 frontmatter description 是否准确反映触发场景
2. 复制到项目级目录：
   cp workspace/<sid>/skills/<name>.md   D:/MyAI/Manuscopy/skills/<name>.md
   cp workspace/<sid>/knowledge/<name>.json D:/MyAI/Manuscopy/knowledge/<name>.json
   cp workspace/<sid>/scripts/<name>.py     D:/MyAI/Manuscopy/scripts/<name>.py
3. 重启 dev server（让 vision helper 等重载 skill 缓存）
4. 跑一个测试任务验证 skill 命中触发场景
```

如果支持自动 promote：
```bash
python scripts/promote_skill.py <name>
```

## 反模式（要避免的错误）

| 错误 | 起因 | 正解 |
|---|---|---|
| 把整本 catalog 抄进 .md | 没分层 | 数据进 JSON，方法进 .md |
| skill description 写得太宽（"机加工知识"）| 不够精准 | 写具体触发场景 |
| 跟现有 skill 高度重叠 | 没先 ls skills/ | 补到现有 skill，不要新建 |
| 公式只放在 .md 里让 LLM 心算 | 不知道写脚本 | 公式 → Python 脚本 |
| skill 太长（30KB+）| 不知道拆 | 拆主 + 案例库 |
| 没有 cross-link | 孤立 skill | 必须关联现有 skill |
| 没写来源 | 不可追溯 | 加 `## 来源` 段 |

## 完整工作示例（参考前 5 个 skill 是怎么做出来的）

| 输入 | 输出 |
|---|---|
| 《机械工程图样识绘》36 页 | `drawing-recognition.md`（11.8KB） |
| 《工艺规则》32 页 | `process-planning.md`（17.5KB → 21KB after process-cases） |
| 内置切削数据经验 | `machining-handbook.md` + `materials.json` + `cutting_data.json` + `calc_feeds_speeds.py`（4 件套） |
| 《高级铣工工艺设计》14 页 | `process-cases.md`（10KB）+ 在 process-planning 加 7 条规则 |

每个都遵循"分层 + 简洁 + cross-link + 留来源"。

## 边界（本 skill 不做的事）

- ❌ 不替代用户审核：所有 draft 必须用户看过才 promote
- ❌ 不直接写到项目级 skills/（沙箱安全边界）
- ❌ 不处理非文本资源（视频 / 音频转录另起 workflow）
- ❌ 不覆盖现有同名 skill（除非用户明确 --force）

## 来源 / 灵感

- Manus 的 `skill-creator` 官方 skill（逆向工程笔记 §6.1）
- Anthropic 内置 `anthropic-skills:skill-creator`
- agentskills.io 开放标准
