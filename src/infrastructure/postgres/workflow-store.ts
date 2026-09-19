import { randomUUID } from "node:crypto";
import type {
  WorkflowJob,
  WorkflowStore,
} from "../../application/workflows.js";
import type { QueuedAction } from "../../application/action-queue.js";
import { PostgresDatabase } from "./database.js";

export class PostgresWorkflowStore implements WorkflowStore {
  constructor(private readonly database: PostgresDatabase) {}
  async enqueue(kind: string, payload: Record<string, string>, key: string) {
    const { rows } = await this.database.query(
      `INSERT INTO workflow_jobs(id,kind,payload,dedupe_key,status) VALUES($1,$2,$3,$4,'queued')
      ON CONFLICT(dedupe_key) WHERE status IN ('queued','running') DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id`,
      [randomUUID(), kind, JSON.stringify(payload), key],
    );
    return String(rows[0].id);
  }
  async find(id: string) {
    const { rows } = await this.database.query("SELECT id,status,attempts,error FROM workflow_jobs WHERE id=$1", [id]);
    return rows[0] ?? null;
  }
  async claim(owner: string): Promise<WorkflowJob | null> {
    await this.database
      .query(`UPDATE workflow_jobs SET status='failed',error='Worker interrupted; retry limit reached',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL
      WHERE status='running' AND lease_expires_at<now() AND attempts>=max_attempts`);
    const { rows } = await this.database.query(
      `WITH candidate AS (
      SELECT id FROM workflow_jobs WHERE (status='queued' AND next_attempt_at<=now()) OR (status='running' AND lease_expires_at<now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE workflow_jobs j SET status='running',attempts=attempts+1,lease_owner=$1,
      lease_expires_at=now()+interval '60 seconds',started_at=now()
      FROM candidate WHERE j.id=candidate.id RETURNING j.*`,
      [owner],
    );
    if (!rows[0]) return null;
    return {
      id: String(rows[0].id),
      kind: String(rows[0].kind),
      payload: rows[0].payload as Record<string, string>,
      attempts: Number(rows[0].attempts),
    };
  }
  async renew(id: string, owner: string) {
    return Boolean(
      (
        await this.database.query(
          `UPDATE workflow_jobs SET lease_expires_at=now()+interval '60 seconds'
      WHERE id=$1 AND lease_owner=$2 AND status='running' AND lease_expires_at>now() RETURNING id`,
          [id, owner],
        )
      ).rowCount,
    );
  }
  async finish(id: string, owner: string, error?: string) {
    await this.database.query(
      `UPDATE workflow_jobs SET
      status=CASE WHEN $3::text IS NULL THEN 'completed' WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,
      error=$3,finished_at=CASE WHEN $3::text IS NULL OR attempts>=max_attempts THEN now() ELSE NULL END,
      next_attempt_at=now()+make_interval(secs=>LEAST(300,5*power(2,attempts)::int)),lease_owner=NULL,lease_expires_at=NULL
      WHERE id=$1 AND lease_owner=$2 AND status='running' AND lease_expires_at>now()`,
      [id, owner, error?.slice(0, 500) ?? null],
    );
  }
  async saveActivity(action: QueuedAction) {
    await this.database.query(
      `INSERT INTO activity(id,document) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET document=excluded.document,updated_at=now()`,
      [action.id, JSON.stringify(action)],
    );
    await this.database.query(
      `DELETE FROM activity WHERE id IN (SELECT id FROM activity WHERE document->>'status' IN ('completed','failed') ORDER BY updated_at DESC OFFSET 100)`,
    );
  }
  async snapshot() {
    const [activity, jobs] = await Promise.all([
      this.database.query(
        "SELECT document FROM activity ORDER BY updated_at DESC LIMIT 100",
      ),
      this.database.query(
        "SELECT * FROM workflow_jobs ORDER BY created_at DESC LIMIT 100",
      ),
    ]);
    const actions = activity.rows.map((row) => row.document as QueuedAction);
    for (const job of jobs.rows)
      actions.push({
        id: String(job.id),
        kind:
          job.kind === "evaluation"
            ? "semantic-evaluation"
            : job.kind === "delivery"
              ? "delivery"
              : "ingestion",
        label: `${job.kind} workflow`,
        detail: `Attempt ${job.attempts} of ${job.max_attempts}`,
        status: job.status as QueuedAction["status"],
        context: job.payload as Record<string, string>,
        queuedAt: (job.created_at as Date).toISOString(),
        startedAt: job.started_at
          ? (job.started_at as Date).toISOString()
          : null,
        finishedAt: job.finished_at
          ? (job.finished_at as Date).toISOString()
          : null,
        error: job.error ? String(job.error) : null,
      });
    actions.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
    const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
    for (const action of actions) counts[action.status]++;
    return { generatedAt: new Date().toISOString(), counts, actions };
  }
  async recoverActivity() {
    await this.database
      .query(`UPDATE activity SET document=document || jsonb_build_object('status','failed','error','Server restarted; workflow will recover separately','finishedAt',now())
      WHERE document->>'status' IN ('queued','running')`);
    await this.database.query(
      "UPDATE delivery_intents SET status='uncertain',updated_at=now() WHERE status='sending'",
    );
    await this.database.query(
      "UPDATE ingestion_runs SET status='failed',error='Server restarted',finished_at=now() WHERE status='running'",
    );
  }
}
