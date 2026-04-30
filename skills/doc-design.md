---
name: doc-design
description: 当任务要"做报告 / Word 文档 / PDF / 工艺方案 / 说明书 / 操作手册 / 用户手册 / 项目总结"时启用。把"工程文档 5 大要素 + 排版规范 + Markdown→DOCX/PDF 工作流"压缩进一份指引。配合 scripts/build_docx.py + scripts/md2pdf.py 落地。
---

# Document Design — 工程文档排版速查

> 给 agent 做出"看着是发出去能用"的 Word/PDF 报告，而不是终端 echo 的纯文本。

## 触发场景

- 用户说"做一份 Word / .docx / PDF / 报告 / 方案 / 说明书 / 手册"
- 任务输出结构化（章节 + 表格 + 数据），适合书面交付
- 用户说"打印 / 给客户 / 提交评审"
- 知识吸纳任务的输出（distill PDF 后写一份 review.docx）

## ⭐ 工程文档 5 大要素

每份正式文档都要齐：

1. **封面 / 标题块** — 标题 + 副标题 + 作者/日期（build_docx.py 自动生成）
2. **章节层级** — 用 H1/H2/H3 三层最佳，超过 3 层就该拆文件
3. **核心结论前置** — 每章开头一段总结（不要让读者读 5 页才知道结论）
4. **数据用表 / 图，不要纯文字** — 切削参数列表、对比矩阵、数据摘要
5. **来源 / 版本 / 联系方式** — 文末一段 metadata

## 排版规范（中文工程文档）

### 字号
- H1 大标题：22pt 加粗（建议居中）
- H2：16pt 加粗
- H3：13pt 加粗
- 正文：11pt（非常重要的数字可单独 14pt）
- 表格：10pt
- 引用 / 脚注：10pt 灰色

### 字体（python-docx 已内置）
- 中文：Microsoft YaHei
- 英文/数字：Calibri
- 代码：Consolas
- **不要中英文混用同一字体** —— python-docx 已自动处理

### 行距 / 段距
- 正文行距 1.5
- 段后距 6pt
- 章标题前距 12pt（章节之间留呼吸）

### 表格
- 表头加底色（accent 色）+ 白字
- 偶数行可加浅灰 zebra（python-docx Light Grid Accent 1 已自带）
- 列宽自适应内容；尽量不超过 6 列（超了就横排或拆表）

### 图片
- 居中 + 下方一行小字 caption（说明编号、来源）
- 默认宽度 5.5 英寸（接近 A4 正文宽）
- 矢量图（SVG）不能直接进 .docx，先用 cairosvg 或 PIL 转 PNG

## Markdown → DOCX 工作流（最快）

`build_docx.py` 直接吃 markdown：

\`\`\`bash
python scripts/build_docx.py --md report.md --out workspace/report.docx --title "工艺方案"
\`\`\`

**支持的 markdown 语法**：
- `# H1` / `## H2` / `### H3`
- 段落、空行分段
- 无序列表（`-` `*` `+`）
- 有序列表（`1.` `2.`）
- 引用块（`>`）
- 代码块（` ``` `）
- GitHub 风格表格（`| ... |`）
- 图片（`![caption](path.png)`）
- `---` 强制分页

第一行的 `# H1` 会自动变成文档标题（除非用 `--title` 覆盖）。

## Markdown → PDF 工作流（高质量）

`md2pdf.py` 用 Playwright + Chromium 打印（CSS 渲染极好）：

\`\`\`bash
python scripts/md2pdf.py --md report.md --out workspace/report.pdf --title "..." --theme light
\`\`\`

主题：`light` / `minimal` / `tech` / `warm`。
- `--no-toc` 关闭目录
- `--save-html debug.html` 同时保存中间 HTML（debug 用）

**与 docx 的取舍**：
- 客户/外部分享 → PDF（不可改、跨平台）
- 内部协作 / 客户需要复制粘贴 → DOCX

## JSON spec 路线（精细控制）

不想用 markdown 时直接写 JSON：

\`\`\`json
{
  "title": "工艺设计报告",
  "author": "Manuscopy",
  "blocks": [
    {"type": "h1", "text": "1. 概述"},
    {"type": "p", "text": "..."},
    {"type": "table", "headers": [...], "rows": [...]},
    {"type": "image", "path": "schematic.png", "caption": "图 1"},
    {"type": "pagebreak"},
    {"type": "h1", "text": "2. ..."}
  ]
}
\`\`\`

## 反模式

❌ 全文 H1（每段都是大标题）
❌ 中文字体用了带衬线（宋体）做大标题 → 投影看着糊
❌ 表格列宽手动撑开导致超出页边
❌ 把代码贴进正文（不用 ``` 代码块） → 自动换行炸了
❌ 图片不加 caption / 编号
❌ 一份 30 页报告全用一种字号
❌ "TODO" 占位符没替换就交付（critic 会抓）

## 工程文档常见结构

### 工艺方案 / 加工方案
1. 概述（材料、尺寸、公差）
2. 加工流程（粗→精→检）
3. 切削参数表
4. 刀具清单
5. NC 程序（代码块）
6. 检验方法

### 项目报告
1. 摘要（≤ 200 字结论）
2. 背景
3. 方法
4. 结果（带表 / 图）
5. 讨论
6. 结论
7. 附录（原始数据 / 代码）

### 用户手册
1. 安装
2. 快速开始（hello-world 5 分钟）
3. 核心概念
4. 详细 API / 操作
5. 常见问题
6. 故障排查
7. 联系支持

## 工作流（推荐顺序）

1. **先列 outline 给用户看一眼**（避免方向跑偏）
2. **逐章写 markdown**（不要一上来就 DOCX）
3. **跑 build_docx.py 生成草稿** → 让用户看看排版
4. **如果排版有问题** → 改 markdown → 重新生成（不要在 .docx 里手编）
5. **最终交付时同时出 .docx + .pdf**（用户两份都要）

## 边界

- ❌ 不做 LaTeX（数学公式复杂场景才必要）
- ❌ 不做带交互（嵌入视频/链接到外部）
- ❌ 不直接编辑用户上传的现有 .docx（需求另起 workflow）

## 来源

- python-docx 官方文档
- 国标 GB/T 7713 学术论文格式参考
- 项目实战工艺报告排版规范
