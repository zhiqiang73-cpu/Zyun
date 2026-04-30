---
name: slide-design
description: 当任务要"做 PPT / 演示文稿 / 路演 deck / 教学幻灯片 / 汇报材料"时启用。把"演示设计 5 大原则 + 12 张黄金结构 + 反模式清单 + 配色方案"压缩进一份指引。配合 scripts/build_pptx.py 落地为 .pptx。
---

# Slide Design — 演示文稿设计速查

> 给 agent 做出"看着是会议室里能用的"演示，而不是教科书一样塞满文字的 PPT。

## 触发场景

- 用户说"做 PPT / slide deck / 演示 / 路演 / 汇报材料 / 教学幻灯片"
- 任务输出要给非技术听众展示（产品发布、会议、路演）
- 用户上传 outline / markdown 让转 PPT
- 总结性任务（"把这本书整理成 PPT"）

## ⭐ 5 大原则（每张都要满足）

### 1. 一张一个核心
**每页只放一个信息**。不是一页 5 个 bullet 都同等重要——挑一个最重要的，其他换页。
- ❌ 反模式：标题 + 8 条 bullet + 1 张图 + 一个表 → 等于没讲
- ✅ 正解：12 张干净 > 6 张密集

### 2. 字号要狠
- 标题：≥ 36pt（远处也能看清）
- 正文 bullet：≥ 22pt
- 注释/来源：≥ 14pt
- **看不清就是没用** — 字号不够时砍内容，不要继续缩字号

### 3. 强对比 + 大留白
- 深色主题：bg 接近黑 + 字浅色 → 深色房间能看
- 亮色主题：bg 浅 + 字深色 → 亮房间投影能看
- 每页四周留白至少 0.6 英寸

### 4. 用图代替字
能用一张图说清楚的，不要写 5 句话。但**不要用 stock photo 凑数**——如果没合适的图就空着。

可用资源：
- 工程图 / 截图 / 数据图表（自己生成的优先）
- 简单 icon（lucide / phosphor）
- **避免**：玻璃球、握手、大笑模特、抽象渐变

### 5. 数字要单独成页
"良品率 85%" 写成一句话埋在 bullet 里 = 没人看见。单独一页大字 `85%`，下面一行小字 `良品率（环比 +12%）` = 人人记住。

→ 用 `stats` layout（python-pptx + build_pptx.py 已实现）

## 12 张黄金结构（路演 / 汇报通用）

| # | 类型 | layout | 内容 |
|---|---|---|---|
| 1 | Title | title | 主题 + 副标题 |
| 2 | 痛点 | content | 用户/客户的具体痛点（1-3 条） |
| 3 | 数据冲击 | stats | 1-3 个核心数字 |
| 4 | 我们的解 | section | "解决方案"分隔页 |
| 5 | 解的核心 | content | 3 条 bullet 描述方法论 |
| 6 | 工作原理 | image | 一张架构图 / 流程图 |
| 7 | 案例 1 | content | 真实数字 + 客户名 |
| 8 | 案例 2 | two_column | 对比"以前 vs 现在" |
| 9 | 数据汇总 | table | 关键指标对比表 |
| 10 | 团队 / 来源 | content | 简短 |
| 11 | 行动呼吁 | quote | 一句金句 |
| 12 | Thanks | thanks | 联系方式 / Q&A |

教学/培训型：把第 2-5 替换成"知识脉络"，第 7-9 换成"练习题/案例分析"。

## 反 AI 美学清单（避免"一看就是 AI 拼的"）

❌ 每页都用 SmartArt（特别是带渐变的箭头流程图）
❌ 字体混用（黑体+宋体+楷体一锅炖）
❌ 每页都有 PowerPoint 默认母版的色块装饰
❌ 把整本 PDF 内容 1:1 塞进 30 页里
❌ 配图全用 emoji 或 ASCII art
❌ "Thank You" 旁边贴一张笑脸 + emoji 火🔥💯

✅ 干净 PPT 的标志：
- 字体只用 1 种（中文 Microsoft YaHei / 英文 Calibri，python-pptx 默认已配）
- 主色只 1 种（其他用灰阶）
- 单页元素 ≤ 3（标题 + 一个图/数字 + 来源）

## 配色方案（python-pptx 已内置 5 套）

| theme 名 | 何时用 |
|---|---|
| `modern` | 默认通用 — 浅灰 bg + 蓝 accent |
| `minimal` | 极简风 — 纯白 + 黑 + 红点 |
| `tech` | 暗色科技 — 黑 bg + 青 accent |
| `warm` | 工艺/匠人 — 米白 + 赭石 + 橄榄绿 |
| `blueprint` | 蓝图风 — 蓝 bg + 黄 accent（工程/工艺主题超合） |

工艺/制造业任务推荐 `blueprint` 或 `warm`；产品发布推荐 `modern`；技术分享推荐 `tech`。

## 工作流（推荐顺序）

1. **先 outline**：列 8-15 张（不要超过 25 张）
2. **写 JSON spec**：按 `scripts/build_pptx.py --schema` 的格式
3. **跑生成**：
   \`\`\`bash
   python scripts/build_pptx.py --spec deck.json --out workspace/deck.pptx
   \`\`\`
4. **如果用户提供原始素材（PDF 教科书 / 长文）**：
   - 先用 helper('summarize') 浓缩成 outline
   - 再按 outline 拼 JSON spec
5. **检查清单**（生成完用 critic skill 自查一遍）

## 数据型 PPT（含图表）

build_pptx.py 现在不直接画图表。如果需要：
- 先用 Python `matplotlib` / `plotly` 出 PNG 图（保存到 workspace）
- 在 spec 里用 `{"layout": "image", "title": "...", "image": "chart.png", "caption": "..."}`

## Spec 写法常见错误

- ❌ `bullets` 写成段落（每条几十字） → 拆成 ≤ 12 字短句
- ❌ table 行 > 6 → 拆成多页 / 改成 stats
- ❌ stats > 4 个 → 一页放 3 个最佳，超过看不清
- ❌ section 标题超长（"第三章 工艺路线设计中需要遵循的 5 大原则及其在某零件上的应用"）→ 缩成 4-8 字

## 边界

- ❌ 不直接生成 keynote / google slides 格式（只做 .pptx，PowerPoint / WPS 都能开）
- ❌ 不做动画 / 切换效果（演讲者讲 > 动效）
- ❌ 不嵌入视频（增加文件大小，兼容性差）

## 来源

- python-pptx 官方文档
- Beautiful.ai / Pitch / Tome 设计观察
- 路演经验：YC Demo Day / TechCrunch Disrupt 公开 deck
- 项目实战反 AI 美学清单
