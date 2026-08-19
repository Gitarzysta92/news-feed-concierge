import { randomUUID } from "node:crypto";

export type ActionKind =
  | "ingestion"
  | "extraction"
  | "semantic-evaluation"
  | "learning"
  | "delivery";

export type ActionStatus = "queued" | "running" | "completed" | "failed";

export interface QueuedAction {
  id: string;
  kind: ActionKind;
  label: string;
  detail: string;
  status: ActionStatus;
  context: Record<string, string>;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface ActionQueueSnapshot {
  generatedAt: string;
  counts: Record<ActionStatus, number>;
  actions: QueuedAction[];
}

export interface ActionHandle {
  readonly id: string;
  start(detail?: string): void;
  complete(detail?: string): void;
  fail(error: unknown, detail?: string): void;
}

export class ActionQueue {
  private readonly actions: QueuedAction[] = [];

  constructor(private readonly recentLimit = 100) {}

  enqueue(input: {
    kind: ActionKind;
    label: string;
    detail: string;
    context?: Record<string, string>;
  }): ActionHandle {
    const action: QueuedAction = {
      id: randomUUID(),
      kind: input.kind,
      label: input.label,
      detail: input.detail,
      status: "queued",
      context: { ...input.context },
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    this.actions.unshift(action);

    return {
      id: action.id,
      start: (detail) => this.start(action.id, detail),
      complete: (detail) => this.complete(action.id, detail),
      fail: (error, detail) => this.fail(action.id, error, detail),
    };
  }

  snapshot(): ActionQueueSnapshot {
    const counts: ActionQueueSnapshot["counts"] = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
    };
    for (const action of this.actions) counts[action.status] += 1;
    return {
      generatedAt: new Date().toISOString(),
      counts,
      actions: this.actions.map((action) => ({ ...action, context: { ...action.context } })),
    };
  }

  private start(id: string, detail?: string): void {
    const action = this.find(id);
    if (!action || action.status !== "queued") return;
    action.status = "running";
    action.startedAt = new Date().toISOString();
    if (detail) action.detail = detail;
  }

  private complete(id: string, detail?: string): void {
    const action = this.find(id);
    if (!action || action.status === "completed" || action.status === "failed") return;
    if (action.status === "queued") action.startedAt = new Date().toISOString();
    action.status = "completed";
    action.finishedAt = new Date().toISOString();
    if (detail) action.detail = detail;
    this.prune();
  }

  private fail(id: string, error: unknown, detail?: string): void {
    const action = this.find(id);
    if (!action || action.status === "completed" || action.status === "failed") return;
    if (action.status === "queued") action.startedAt = new Date().toISOString();
    action.status = "failed";
    action.finishedAt = new Date().toISOString();
    action.error = error instanceof Error ? error.message : String(error);
    if (detail) action.detail = detail;
    this.prune();
  }

  private find(id: string): QueuedAction | undefined {
    return this.actions.find((action) => action.id === id);
  }

  private prune(): void {
    let terminalCount = this.actions.filter((action) => (
      action.status === "completed" || action.status === "failed"
    )).length;
    for (let index = this.actions.length - 1; index >= 0 && terminalCount > this.recentLimit; index -= 1) {
      const action = this.actions[index];
      if (action.status === "completed" || action.status === "failed") {
        this.actions.splice(index, 1);
        terminalCount -= 1;
      }
    }
  }
}
