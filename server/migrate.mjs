import { openDatabase } from "./db.mjs";
const db = await openDatabase({ ...process.env, HEALTHPASS_RUN_MIGRATIONS: "1" });
await db.close();
console.log("HealthPass schema migrations 001 through 008 applied.");
