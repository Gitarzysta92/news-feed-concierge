import "dotenv/config";
import { PostgresDatabase } from "../infrastructure/postgres/database.js";
import { migrate } from "../infrastructure/postgres/migrate.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const database = new PostgresDatabase(process.env.DATABASE_URL);
try { await migrate(database); console.log("Database migrations complete"); }
finally { await database.close(); }
