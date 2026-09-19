import "dotenv/config";
import { PostgresDatabase } from "../infrastructure/postgres/database.js";
import { importSqlite } from "../infrastructure/postgres/import-sqlite.js";
if (!process.env.DATABASE_URL || !process.argv[2]) throw new Error("Usage: DATABASE_URL=... npm run db:import-sqlite -- /path/to/concierge.sqlite");
const database = new PostgresDatabase(process.env.DATABASE_URL);
try { console.log(JSON.stringify(await importSqlite(process.argv[2],database),null,2)); }
finally { await database.close(); }
