---
name: web-design
description: 当任务要"做网站 / 网页 / 落地页 / 仪表盘 / 静态页 / Tailwind / 现代 UI"时启用。把"现代网页设计 5 大原则 + Tailwind 速查 + 配色方案 + 反 AI 美学"压缩进一份能直接套用的工程指引。配合 scripts/build_html.py 落地。
---

# Web Design — 现代网页设计速查

> 给 agent 做出"看着不像 AI 拼的"网页。每条都是从真实产品反推出的具体规则，不是泛泛之谈。

## 触发场景

- 用户要"做网站 / 落地页 / 官网 / 产品页 / 后台 / 小工具页"
- 用户上传截图 / Figma 链接说"照这个做"
- 任务输出要给非技术人员展示（演示用网页）
- 用户没明说但任务本质是 web 端可视化（dashboard / 表单 / 文档站）

## ⭐ 5 大设计原则（每页都要满足）

### 1. 留白要狠
- 主标题区上下 padding 至少 `py-20 md:py-32`
- 卡片之间 gap 至少 `gap-6`
- 文字区单列宽度不超过 `max-w-3xl`（≈ 65 字符宽）
- **反模式**：把屏幕填满，每像素都用上 → 看着像 craigslist

### 2. 字号层级要拉开
默认 16px 是底，大标题要狠：
| 用途 | Tailwind class | px |
|---|---|---|
| 大 hero | `text-5xl md:text-7xl` | 48 / 72 |
| 区块标题 | `text-3xl md:text-4xl` | 30 / 36 |
| 副标题 | `text-xl md:text-2xl` | 20 / 24 |
| 正文 | `text-base` 或 `text-lg` | 16 / 18 |
| 注释/标签 | `text-sm text-muted` | 14 |

**反模式**：H1 用 `text-2xl`，H2 用 `text-xl` —— 没有视觉冲击。

### 3. 一种主色 + 一种强调色
- 主色（accent）：用户的 brand 色或 `#5b8def` 蓝
- 强调色（accent2）：互补色或 warm orange `#F6A046`
- **不要超过 3 种颜色**（除黑白灰）

参考配色方案见 `knowledge/design_palettes.json`（如有）。

### 4. 卡片有边、有圆角、不要阴影暴力
- 默认：`rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6`
- hover：`hover:border-[var(--accent)] transition`
- 阴影：用就用 `shadow-lg`，不要 `shadow-2xl` 全屏炸
- **反模式**：硬阴影 + 不规则圆角 + 渐变背景 → AI 美学三件套

### 5. 暗色 / 亮色都要好看
默认双主题：
\`\`\`css
:root { --bg: #fff; --fg: #1a1f2c; --accent: #5b8def; ... }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0b0e14; --fg: #e6e9ef; ... }
}
\`\`\`

或显式 toggle：用 `data-theme="dark"` 属性切换。

## 反 AI 美学清单（避免"一看就是 AI 写的"）

❌ 玻璃态背景 + 大量渐变 + emoji 当图标
❌ 紫粉渐变 (#6366F1→#EC4899) 当主色
❌ 全屏视频背景 + 浮动 CTA 按钮
❌ 每张卡片都有 hover 旋转 / 浮起 / 缩放动画
❌ "AI Powered" / "Next-Gen" 这类口号
❌ 占位图全用 unsplash 风景

✅ 真正的好设计是**克制**：
- 中性灰背景 + 单色 accent
- 清晰的网格对齐（左对齐多）
- 真实数据而不是 lorem ipsum
- 用图标库（lucide / heroicons / phosphor），不用 emoji 当主图

## 快速骨架（直接拿来改）

### Hero + Features + CTA（最常用）
\`\`\`bash
python scripts/build_html.py --template hero --out workspace/index.html --title "你的产品"
\`\`\`

会生成 4 个区块：hero / features / stats / footer。然后 Read 出来按需改文案/区块顺序。

### 文档型（长文 + 目录）
\`\`\`bash
python scripts/build_html.py --md article.md --out article.html --title "..." --theme light
\`\`\`

或先转 PDF（更适合发出去）：
\`\`\`bash
python scripts/md2pdf.py --md article.md --out article.pdf --title "..."
\`\`\`

### 仪表盘 / 数据页
- 用 [Chart.js CDN](https://cdn.jsdelivr.net/npm/chart.js) 或 [Recharts](https://recharts.org)（如果是 React）
- 卡片 grid `grid-cols-2 md:grid-cols-4`，每张卡只放一个核心数字（参考 build_html.py 的 stats section）

## 工作流（推荐顺序）

1. **先用 build_html.py 出骨架**（最快得到能跑的页面）
2. **Read 出 HTML → 按需改内容**（不要每次从零写）
3. **如果有 brand 色 → 改 `--accent` 一行就好**
4. **检查响应式**：window resize 看小屏会不会糊
5. **检查暗色**：浏览器开发者工具 emulate prefers-color-scheme
6. **最后检查反模式清单**

## 用户喜好（如果上传了 Figma / 截图）

- 先 Read 截图 → 让 helper('vision') 描述布局（栅格、间距、配色）
- 然后按那个布局复刻，不要自由发挥
- 字号 / 颜色 / 间距尽量对齐截图（用浏览器 inspector 量像素）

## 边界

- ❌ 不做复杂动画 / 3D（用 framer-motion 也只做 fade/slide）
- ❌ 不做 SPA 路由（除非用户明确说要 React/Next，那走 web-app-builder skill）
- ❌ 不引入复杂构建工具（vite/webpack）—— 用 Tailwind CDN 优先

## 来源

- shadcn/ui design tokens
- Tailwind UI patterns
- Apple HIG · Material Design
- 项目实战反 AI 美学清单
