import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostgresDatabase } from "./database.js";
import { checkSchema } from "./migrate.js";

const tables = [
  "articles",
  "channels",
  "users",
  "feedback",
  "evaluations",
  "deliveries",
  "delivery_targets",
  "ingestion_runs",
] as const;

export async function importSqlite(filename: string, target: PostgresDatabase) {
  await checkSchema(target);
  const directory = await mkdtemp(join(tmpdir(), "concierge-import-"));
  let source: Database.Database | undefined;
  let snapshot: Database.Database | undefined;
  try {
    source = new Database(filename, { readonly: true, fileMustExist: true });
    await source.backup(join(directory, "snapshot.sqlite"));
    snapshot = new Database(join(directory, "snapshot.sqlite"), {
      readonly: true,
    });
    return await target.transaction(async () => {
      // The same lock as the running server prevents imports during live operation.
      const lock = await target.query(
        "SELECT pg_try_advisory_xact_lock(73190402) AS owned",
      );
      if (!lock.rows[0].owned)
        throw new Error("Stop the server before importing data");
      for (const table of [
        ...tables,
        "workflow_jobs",
        "activity",
        "delivery_intents",
      ]) {
        const count = await target.query(`SELECT count(*) FROM ${table}`);
        if (Number(count.rows[0].count))
          throw new Error(
            `Import requires an empty target; ${table} is not empty`,
          );
      }
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const columns = (
          await target.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
            [table],
          )
        ).rows.map((row) => String(row.column_name));
        const records = snapshot!
          .prepare(`SELECT * FROM ${table}`)
          .all() as Record<string, unknown>[];
        for (const row of records) {
          const names = columns.filter((name) => Object.hasOwn(row, name));
          // Identifiers come only from our schema and fixed table allowlist.
          await target.query(
            `INSERT INTO ${table} (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`,
            names.map((name) => row[name]),
          );
        }
        counts[table] = records.length;
      }
      // Previous evaluator caches do not carry the new endpoint/prompt identity.
      await target.query("UPDATE evaluations SET cache_key=NULL");
      return counts;
    });
  } finally {
    snapshot?.close();
    source?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
