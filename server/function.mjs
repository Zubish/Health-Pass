import { Pool } from "pg";
import { attachDatabasePool } from "@neon/functions";
import { openDatabase } from "./db.mjs";
import { createApi } from "./api.mjs";
import { createFunctionHandler } from "./function-handler.mjs";

const config = { ...process.env, NODE_ENV: "production", HEALTHPASS_RUN_MIGRATIONS: "0" };

export default createFunctionHandler(config, async () => {
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 });
  attachDatabasePool(pool);
  try {
    const db = await openDatabase(config, { pool });
    return createApi(db, config);
  } catch (error) {
    await pool.end();
    throw error;
  }
});
