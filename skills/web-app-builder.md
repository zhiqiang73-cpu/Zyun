---
name: web-app-builder
description: 当任务要"做网站 / 网页 / 落地页 / 仪表盘 / 后台 / 工具页 / React / Next.js / Tailwind / 上线部署"时启用。这是一份**自主全栈工程师**操作手册：5 阶段（规划 → 初始化 → 实时预览 → 自主调试 → 部署）+ 工具链（dev_serve.py / dev_logs.py / dev_kill.py / deploy.py）。
---

# Web App Builder — 自主全栈工程师 5 阶段流程

> 你不是写说明文档的咨询师，而是**能跑通整个生命周期**的工程师：规划、起脚手架、起 dev server、用浏览器看效果、自己读日志 debug、构建、部署。每一步都用工具完成，不要"建议用户去做"。

## 触发条件

用户出现以下任一意图时，**立刻启用本 skill**：

- 做网站 / 官网 / 落地页 / 作品集 / 仪表盘 / 后台 / 管理系统
- 写 HTML/CSS/JS、React、Next.js、Tailwind 页面
- 做小工具 / 小游戏 / 可视化页面 / 表单 / 组件
- "做完后**部署**到线上 / Vercel / Netlify"
- 上传参考文案/图片/品牌资料后让生成页面

---

## ⭐ 5 阶段执行顺序（每个任务都按这个走，不跳步）

### Phase 1: 架构规划（< 30 秒，TodoWrite 拆步）

读完用户需求 + 上传文件后，**先想清楚**：

- **技术栈**：纯静态 (HTML+Tailwind CDN) / 单页 React (Vite) / SSR (Next.js)
- **页面 / 路由**：列出最多 5 个核心页面或区块
- **关键交互**：表单提交 / 数据可视化 / 拖拽 / 实时计算 / 路由跳转
- **状态需要**：完全无状态（landing）/ localStorage / API 调用

立刻 TodoWrite：
1. 起项目骨架
2. 写核心页面/组件
3. 起 dev server + 自查
4. 必要的 typecheck/build
5. （用户要求时）部署上线

**判断决策**：
- 用户没明说技术栈 + 页数 ≤ 1 + 没有复杂状态 → **HTML + Tailwind CDN**（最快，30 秒能跑）
- 多页面 / 路由 / SEO → **Next.js**（用 `npx create-next-app@latest .`）
- 重交互单页 + 无 SEO → **Vite + React**

### Phase 2: 环境初始化（创建脚手架）

**先检查后建**（防御性）：
```bash
ls -la                        # 看 workspace 当前内容
ls package.json 2>/dev/null   # 已经有项目就不要 init
```

**纯静态**：
直接 `write_file` 出 `index.html`（用 `scripts/build_html.py --template hero` 起骨架更快）。

**Next.js**：
```bash
npx create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes
```
（`.` 表示在当前目录初始化；`--yes` 跳过交互式提问）

**Vite + React**：
```bash
npm create vite@latest . -- --template react-ts
npm install
```

**npm 网络坑**：如果 `npx create-next-app` 卡住或超时，立刻切镜像：
```bash
npm config set registry https://registry.npmmirror.com
```

### Phase 3: 迭代开发 + 实时预览

#### 起 dev server（**关键工具**）

写完核心代码后**立刻启动 dev server**——不要等到全部写完再看效果：

```bash
python scripts/dev_serve.py
```

它会：
- 自动检测 Next.js / Vite / 静态 HTML
- 在 3100-3199 范围找一个空闲端口
- 后台启动，pid + port + log 落到 `.manuscopy_devserver.json`
- 等 20s 看端口能不能 connect / 日志有没有致命错误
- 输出 JSON 状态

**结果会自动同步到 Manuscopy UI 的 Live Preview tab**——用户能在 iframe 里实时看到。

#### 增量改

按 TodoWrite 一步步推进。每改一个页面/组件：
- `write_file` 或 `Edit` 改代码
- dev server 自带热更新，**不需要重启**（Next/Vite 都自带 HMR）
- 静态 HTML 改完直接刷新 iframe（UI 上有刷新按钮）

#### 想看当前是否还在跑：
```bash
python scripts/dev_serve.py --status
```

### Phase 4: 自主调试与纠错（**最重要**）

**绝对不要**对用户说"启动失败了你看一下" —— 你必须自己读日志、自己改、自己重启。

#### 标准 debug 循环

```bash
# 1. 看最近的错误日志
python scripts/dev_logs.py --errors-only --tail 50

# 2. 如果看到 ERROR / SyntaxError / Cannot find module / EADDRINUSE / Failed to compile:
#    - 读对应文件（Read tool）
#    - 修代码（Edit tool）
#    - 重启
python scripts/dev_serve.py --restart

# 3. 重新看是否好了
python scripts/dev_logs.py --tail 30
```

#### 常见错误 + 速修

| 日志症状 | 根因 | 修法 |
|---|---|---|
| `Cannot find module 'X'` | 漏装依赖 | `npm install X` |
| `EADDRINUSE` / 端口占用 | 上次没杀掉 | `python scripts/dev_kill.py` 然后 `dev_serve.py` |
| `SyntaxError` / `Unexpected token` | TS/JSX 错 | Read 对应行 + Edit |
| `Failed to compile` (Tailwind) | tailwind config 没 content path | 改 `tailwind.config.js` 加 `'./app/**/*.{js,ts,jsx,tsx}'` |
| `ENOENT` package.json missing | 没初始化 | 跑 Phase 2 |
| 起来了但页面空白 | JS 报错 | 浏览器 console 看不到，但 server log 里 SSR 报错会写出来 |

**调试上限**：同一个 task 里同一个错连续出现 3 次还修不好 → 停下来用 `helper('reason')` 想一想，或者向用户说明在卡哪里。**别陷入死循环**。

### Phase 5: 打包与部署

#### Build 自查（确认能编译）

```bash
npm run build 2>&1 | tail -50
```

构建失败优先级 > 一切。**编译错的项目不能交付**。

#### Deploy（用户明确说"上线"时）

```bash
python scripts/deploy.py --build --prod
```

它会：
1. 自动 `npm run build`
2. 按可用环境变量自动选目标：
   - `VERCEL_TOKEN` 已设 → Vercel
   - `NETLIFY_AUTH_TOKEN` 已设 → Netlify
   - 都没设 → 打包成 `_dist.zip` 放 workspace（用户自己上传）
3. 输出 JSON：`{"ok": true, "target": "vercel", "url": "https://..."}`

把那个 url 报给用户。

如果用户没 token，给清晰的两条路：
- "我把 `_dist.zip` 准备好了，你解压后丢到 GitHub Pages / Cloudflare Pages 即可" + 操作步骤
- "如果想自动上线，请在 .env 加 VERCEL_TOKEN 或 NETLIFY_AUTH_TOKEN，然后 follow-up '部署一下'"

#### Stop dev server（结束清理）

任务交付完成后：
```bash
python scripts/dev_kill.py
```

避免端口占用影响下个任务。

---

## ⭐ 关键工具速查（这些必须用，不要 cargo-cult 别的）

| 工具 | 用途 | 最常用形式 |
|---|---|---|
| `dev_serve.py` | 起后台 dev server，端口自动选 | `python scripts/dev_serve.py` |
| `dev_serve.py --status` | 查询当前 dev server 状态 | 不重复起 |
| `dev_serve.py --restart` | 杀旧重启（改了 config 后） | 改 next.config / tailwind.config 后 |
| `dev_logs.py` | 看 dev server 输出 | `--errors-only` 或 `--tail 50` |
| `dev_kill.py` | 杀掉 dev server | 任务结束 / 切技术栈时 |
| `deploy.py` | 一键部署 | `--build --prod` |
| `build_html.py` | 出 modern HTML 骨架 | `--template hero` 最快 |

---

## 设计规范（**避免 AI 美学**——参考 web-design.md）

- 默认 Tailwind + 中性灰背景 + 单一 accent（不要紫粉渐变）
- 字体只 1 种（Microsoft YaHei + Inter）
- 大留白 / 大字号 / 强对比
- 真实文案数据（拒绝 lorem ipsum）

更详细看 `skills/web-design.md`。

---

## 防御性编程清单

- ✅ 先 `ls` 看 workspace 状态再决定建/改
- ✅ 端口冲突先 `dev_kill.py`（不要 lsof，dev_kill 自带）
- ✅ 启动后等 5-10s 再 `dev_logs.py` 看日志（next.js 第一次编译要时间）
- ✅ Build 失败别假装成功；先修编译再说部署
- ❌ 不要用 `npm run dev` 直接前台跑（会卡住你；用 dev_serve.py）
- ❌ 不要给用户发"请你打开 localhost:xxx 看看"——你已经有 Live Preview UI 了

---

## 边界

- ❌ 不做后端登录 / 支付 / 真实数据库写入（除非用户明确要求）
- ❌ 不暴露环境变量 / API key 到前端
- ❌ 不把不可访问的远程资源作为唯一关键内容
- ❌ 不在用户没说"上线"时自动 deploy

---

## 速通示例

**用户**: "做一个深色风格的产品介绍页，主题是 X"

```
TodoWrite: [起骨架, 改文案, 起 dev server, build]
↓
python scripts/build_html.py --template hero --out index.html --theme dark
↓
Edit index.html (改文案 + 区块)
↓
python scripts/dev_serve.py
   → {"ok": true, "port": 3100, "url": "http://localhost:3100"}
   → UI 的 Live Preview tab 自动出现
↓
python scripts/dev_logs.py --tail 10  ← 确认无报错
↓
向用户说："已起到 :3100，看 Live Preview tab；满意我就 build / 部署"
```

3 个工具调用，30-60 秒，跑完。不是"我帮你想了一个方案"。
