import { openDatabase } from "../server/db.mjs";
import { randomUUID } from "node:crypto";
// Embedded PostgreSQL engine exercises actual PostgreSQL schema/trigger/query semantics.
// Network/TLS, hosted roles, backups and multi-process locks still require pilot staging checks.
export async function openTestDatabase() {
  if (process.env.HEALTHPASS_TEST_ENGINE === "postgres-live") {
    const connection = new URL(process.env.HEALTHPASS_TEST_POSTGRES_URL);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(connection.hostname)) {
      throw new Error("Live integration checks require an isolated local PostgreSQL server.");
    }
    const { Pool } = await import("pg");
    const admin = new Pool({ connectionString: connection.toString() });
    const name = "hp_test_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE DATABASE "${name}"`);
    connection.pathname = "/" + name;
    const db = await openDatabase({ DATABASE_URL: connection.toString() });
    return {
      ...db,
      async close() {
        await db.close();
        await admin.query(`DROP DATABASE "${name}"`);
        await admin.end();
      },
    };
  }
  if (process.env.HEALTHPASS_TEST_ENGINE !== "postgres") {
    return openDatabase({ HEALTHPASS_SQLITE_PATH: ":memory:" });
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  let tail = Promise.resolve();
  const pool = {
    async connect() {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      return {
        release,
        async query(sql, args = []) {
          if (!args.length && sql.split(";").filter((part) => part.trim()).length > 1) {
            const values = await pg.exec(sql);
            const value = values.at(-1) ?? {};
            return { ...value, rowCount: value.affectedRows ?? 0 };
          }
          const value = await pg.query(sql, args);
          return { ...value, rowCount: value.affectedRows ?? 0 };
        },
      };
    },
    async end() {
      await pg.close();
    },
  };
  return openDatabase({ DATABASE_URL: "postgresql://embedded-test" }, { pool });
}
