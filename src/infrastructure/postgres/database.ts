import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

export class PostgresDatabase {
  readonly pool: Pool;
  private readonly transactionClient = new AsyncLocalStorage<PoolClient>();

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 12,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
    });
    this.pool.on("error", (error) =>
      console.error("PostgreSQL idle connection failed", error.message),
    );
  }

  query<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ) {
    return (this.transactionClient.getStore() ?? this.pool).query<T>(
      sql,
      values,
    );
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionClient.getStore()) return work();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.transactionClient.run(client, work);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}
