import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PostgresDatabase } from "./database.js";

export const migrationsDirectory = fileURLToPath(
  new URL("../../../db/migrations/", import.meta.url),
);

export async function migrate(database: PostgresDatabase) {
  await database.transaction(async () => {
    await database.query("SELECT pg_advisory_xact_lock(73190401)");
    await database.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    for (const name of (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(join(migrationsDirectory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const { rows } = await database.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (rows.length) {
        if (rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await database.query(sql);
      await database.query(
        "INSERT INTO schema_migrations(name, checksum) VALUES ($1,$2)",
        [name, checksum],
      );
    }
  });
}

export async function checkSchema(database: PostgresDatabase) {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const { rows } = await database.query(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  if (JSON.stringify(rows.map((row) => row.name)) !== JSON.stringify(names)) {
    throw new Error(
      "Database schema does not match this release; run npm run db:migrate",
    );
  }
}
