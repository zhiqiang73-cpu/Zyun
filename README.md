# Manuscopy

A self-hosted, Manus-style autonomous agent platform built on top of the **Claude Agent SDK**. Two-pane UI: chat stream on the left, live Canvas (file tree + content viewer + HTML preview) on the right.

This is the MVP (v0.1) — extracted from the architecture in
[`/D:/MyAI/知识库/20-领域知识/Manus逆向工程笔记.md`](../知识库/20-领域知识/Manus逆向工程笔记.md).

## What works in v0.1

- ✅ Type a prompt → agent runs autonomously in a per-task workspace folder
- ✅ Plan-Execute UX (LLM uses `TodoWrite` → renders as a checked-off TODO list)
- ✅ Tool call cards in chat: `terminal`, `text_editor`, `search`, `web_fetch`, …
- ✅ Live Canvas right pane: workspace file tree, text/code viewer, image preview, HTML iframe preview
- ✅ Polling-based event stream (no WebSocket needed) — same architecture as Manus
- ✅ Built-in safety: prompt-injection attempts get the standard "We can not process your request now" reply
- ✅ Persistent storage in JSON files (`data/`) — no native deps, works on Windows without Visual Studio

## Not in v0.1 (will come later)

- ❌ Skills auto-discovery (Hermes-style learning loop)
- ❌ MCP / Connectors integration (we have the design — just not wired)
- ❌ Image generation (`media_viewer` tool — needs Imagen/Flux API integration)
- ❌ Suggestion subagent (the predictive "next prompt" feature)
- ❌ Follow-up messages mid-task
- ❌ Docker sandbox (currently uses host filesystem at `workspaces/<id>/`)
- ❌ Agent mode (multi-channel deployment)

## Setup

**Prereqs**: Node.js 20+ (24 tested) and an Anthropic API key.

```bash
# 1. Install
npm install

# 2. Configure your API key
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY=sk-ant-...

# 3. Run dev server
npm run dev
```

Open http://localhost:3000 — type a task, hit `Cmd/Ctrl+Enter`.

### First-time tip

The Claude Agent SDK ships a bundled Claude Code binary. On first run it may need to set up the underlying environment. Watch the terminal for any prompts.

## Architecture (one-pager)

```
┌──────────────────────────────────────────────────────┐
│ Next.js 14 frontend (port 3000)                       │
│ ┌────────────────────┬───────────────────────────┐    │
│ │ ChatStream          │ Canvas                     │    │
│ │ - chat bubbles      │ - File tree                 │    │
│ │ - PlanView (TODO)   │ - Text/code viewer          │    │
│ │ - ToolCard          │ - Image preview             │    │
│ │                     │ - HTML iframe preview       │    │
│ └─────────────┬───────┴─────────────┬─────────────┘    │
└───────────────┼─────────────────────┼──────────────────┘
                │ POST /api/tasks     │ GET /api/tasks/:id/events?after=<ts>
                │ (start)             │ (poll @ 1Hz)
       ┌────────▼─────────────────────▼───────────┐
       │ Next.js API routes (Node.js runtime)       │
       │ + Orchestrator (lib/orchestrator.ts)       │
       │   wraps Claude Agent SDK, translates       │
       │   SDK messages → Manus-style events.       │
       └──────┬─────────────────────┬───────────────┘
              │                     │
       ┌──────▼──────────┐   ┌──────▼──────────┐
       │ data/            │   │ workspaces/<id>/ │
       │ - sessions.json  │   │ (agent's cwd —    │
       │ - events_*.jsonl │   │  files materialize │
       │                  │   │  here)            │
       └──────────────────┘   └──────────────────┘
                                      │
                              ┌───────▼─────────┐
                              │ Claude Agent SDK│
                              │ ↳ Bash, Edit,   │
                              │   WebSearch,    │
                              │   TodoWrite, …  │
                              └─────────────────┘
```

### Tool naming map

| Manus tool name (UI shows) | Claude Agent SDK | Action verb |
|---|---|---|
| `terminal`     | `Bash`        | "Executing command" |
| `text_editor`  | `Read`        | "Reading file" |
| `text_editor`  | `Write`       | "Creating file" |
| `text_editor`  | `Edit`        | "Editing" |
| `text_editor`  | `Glob`/`Grep` | "Listing files" / "Searching files" |
| `search`       | `WebSearch`   | "Searching" |
| `web_fetch`    | `WebFetch`    | "Fetching URL" |
| `media_viewer` | (not in SDK)  | reserved — needs custom integration |
| `suggestion`   | (not in SDK)  | reserved — needs subagent |

### Event types implemented

Subset of Manus's 15 types:

- `chat`, `chatDelta` — user/assistant messages
- `planUpdate`, `newPlanStep` — plan state machine (rendered as TODO list)
- `toolUsed` — tool calls (rendered as cards, with status pending → success/error)
- `statusUpdate`, `liveStatus` — high/low-frequency status pulses
- `sandboxUpdate`, `queueStatusChange`, `taskModeChanged` — lifecycle bookkeeping

## Project layout

```
app/
  layout.tsx, globals.css
  page.tsx                              # Dashboard
  tasks/[id]/page.tsx                   # Task view (chat + canvas)
  api/tasks/
    route.ts                            # POST create / GET list
    [id]/route.ts                       # GET session meta
    [id]/events/route.ts                # GET events polling
    [id]/files/route.ts                 # GET workspace files
components/
  chat-stream.tsx, plan-view.tsx, tool-card.tsx
  canvas.tsx, file-tree.tsx
lib/
  types.ts                              # Event/Session/Tool types
  db.ts                                 # JSON file storage
  orchestrator.ts                       # Claude Agent SDK wrapper
  utils.ts                              # cn() + relTime()
data/                                   # runtime; gitignored
workspaces/                             # runtime; gitignored
```

## Roadmap (next iteration)

1. **Suggestion subagent** — after each task, fire a small subagent to produce 3 pre-compiled "next-task" prompts (Manus's `fileOperationPromotion.promptForAI` mechanism). Render as clickable cards.
2. **Skills** — wire SDK's Skills auto-discovery; auto-generate a `skills/<topic>.md` file at task end.
3. **MCP integration** — let users toggle MCP servers; SDK already supports MCP.
4. **Follow-up** — text input at bottom of task page; sends new user message to ongoing/finished session.
5. **Docker sandbox** — replace host workspace with per-task container.
6. **Image generation** — wire a `media_viewer` custom tool to Imagen/Flux/SDXL.

## Knowledge note

The reverse-engineering basis for every architecture choice in this codebase is in
`D:/MyAI/知识库/20-领域知识/Manus逆向工程笔记.md` — refer to it before changing core types.
