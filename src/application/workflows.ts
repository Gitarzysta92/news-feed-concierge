import { randomUUID } from "node:crypto";

export interface WorkflowJob {
  id: string;
  kind: string;
  payload: Record<string, string>;
  attempts: number;
}
export interface WorkflowStore {
  enqueue(
    kind: string,
    payload: Record<string, string>,
    key: string,
  ): Promise<string>;
  claim(owner: string): Promise<WorkflowJob | null>;
  renew(id: string, owner: string): Promise<boolean>;
  finish(id: string, owner: string, error?: string): Promise<void>;
}

export class Workflows {
  private readonly owner = randomUUID();
  private readonly handlers = new Map<
    string,
    (payload: Record<string, string>) => Promise<unknown>
  >();
  private timer?: ReturnType<typeof setInterval>;
  private current: Promise<void> | null = null;
  constructor(private readonly store: WorkflowStore) {}
  register(
    kind: string,
    handler: (payload: Record<string, string>) => Promise<unknown>,
  ) {
    this.handlers.set(kind, handler);
  }
  enqueue(kind: string, payload: Record<string, string> = {}, key = kind) {
    return this.store.enqueue(kind, payload, key);
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }
  private tick() {
    if (this.current) return;
    this.current = this.runOnce()
      .catch((error) => console.error("Workflow execution failed", error))
      .finally(() => {
        this.current = null;
      });
  }
  async runOnce() {
    const job = await this.store.claim(this.owner);
    if (!job) return;
    // This server is single-owner. Losing the lease must stop it before another
    // owner is allowed to continue external side effects.
    let renewing: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = this.store
        .renew(job.id, this.owner)
        .then((owned) => {
          if (!owned) {
            console.error("Workflow lease lost; stopping server");
            process.exit(1);
          }
        })
        .catch(() => {
          console.error("Workflow lease renewal failed; stopping server");
          process.exit(1);
        }).finally(() => { renewing = undefined; });
    }, 10000);
    heartbeat.unref();
    let failure: string | undefined;
    try {
      const handler = this.handlers.get(job.kind);
      if (!handler) throw new Error(`Unknown workflow: ${job.kind}`);
      await handler(job.payload);
    } catch (error) {
      failure = error instanceof Error ? error.message : "Workflow failed";
    } finally {
      clearInterval(heartbeat);
      // A pending renewal must settle before completion changes the job's state.
      await renewing;
    }
    await this.store.finish(job.id, this.owner, failure);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.current;
  }
}
