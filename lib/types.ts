/**
 * Manuscopy data model — directly mirrors Manus's `Session → Segments → Events` structure.
 * Subset of Manus's 15 event types implemented for v0.1.
 *
 * See knowledge note: D:/MyAI/知识库/20-领域知识/Manus逆向工程笔记.md  §10 / §R3.7
 */

export type SessionStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'stopped';

export type Session = {
  id: string;
  title: string;
  status: SessionStatus;
  taskMode: 'standard' | 'lite';
  costedCredits: number;
  createdAt: number;
  updatedAt: number;
};

/** All event types Manus uses (we emit the marked subset for MVP). */
export type EventType =
  // emitted in MVP v0.1
  | 'chat'
  | 'chatDelta'
  | 'planUpdate'
  | 'newPlanStep'
  | 'toolUsed'
  | 'statusUpdate'
  | 'liveStatus'
  | 'sandboxUpdate'
  | 'queueStatusChange'
  | 'taskModeChanged'
  // reserved for v0.2+
  | 'explanation'
  | 'fileOperationPromotion'
  | 'sidebarDisplay'
  | 'deploySuccess'
  | 'myBrowserSelection'
  | 'followUpEnded';

export type ToolName = 'text_editor' | 'terminal' | 'search' | 'web_fetch' | 'suggestion' | 'media_viewer' | 'unknown';

/** The unified event row stored in SQLite. */
export type AgentEvent = {
  id: string;
  sessionId: string;
  type: EventType;
  timestamp: number;
  /** chat / chatDelta */
  sender?: 'user' | 'assistant' | 'system';
  content?: string;
  /** plan/step linkage */
  stepId?: string;
  planStepId?: string;
  /** toolUsed */
  tool?: ToolName;
  toolStatus?: 'success' | 'error' | 'pending';
  toolAction?: string; // "Creating file" / "Executing command" / "Searching" / ...
  brief?: string;
  description?: string;
  /** heterogeneous payload */
  payload?: Record<string, unknown>;
};

/** Plan task within a planUpdate event. */
export type PlanTask = {
  status: 'todo' | 'doing' | 'done' | 'skipped';
  title: string;
  startedAt?: number;
};

/** New task creation request body. */
export type CreateTaskRequest = {
  prompt: string;
};

/** Events polling response. */
export type EventsResponse = {
  events: AgentEvent[];
  nextAfter: number; // pass back as ?after= for next poll
  sessionStatus: SessionStatus;
};

/** File listing response item. */
export type FileEntry = {
  path: string;        // relative to workspace root
  name: string;
  isDirectory: boolean;
  size?: number;
  mtime?: number;
};
