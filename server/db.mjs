import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export async function openDatabase(config = process.env, dependencies = {}) {
  let engine, pool;
  if (config.DATABASE_URL) {
    const { Pool } = await import("pg");
    pool = dependencies.pool ?? new Pool({ connectionString: config.DATABASE_URL });
    engine = "postgres";
  } else {
    if (config.NODE_ENV === "production")
      throw new Error("Production requires DATABASE_URL.");
    const path =
      config.HEALTHPASS_SQLITE_PATH ||
      fileURLToPath(new URL("../.data/healthpass.sqlite", import.meta.url));
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    pool = new DatabaseSync(path);
    pool.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    engine = "sqlite";
  }
  const adapt = (connection) => ({
    async all(sql, args = []) {
      if (engine === "sqlite") return connection.prepare(sql).all(...args);
      let n = 0;
      return (
        await connection.query(
          sql.replace(/\?/g, () => `$${++n}`),
          args,
        )
      ).rows;
    },
    async get(sql, args = []) {
      return (await this.all(sql, args))[0];
    },
    async run(sql, args = []) {
      if (engine === "sqlite") return connection.prepare(sql).run(...args);
      let n = 0;
      return connection.query(
        sql.replace(/\?/g, () => `$${++n}`),
        args,
      );
    },
  });
  // Serialize SQLite transactions across await boundaries; PostgreSQL uses dedicated connections.
  let tail = Promise.resolve();
  const db = {
    engine,
    async transaction(fn) {
      if (engine === "sqlite") {
        const previous = tail;
        let release;
        tail = new Promise((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          pool.exec("BEGIN IMMEDIATE");
          try {
            const result = await fn(adapt(pool));
            pool.exec("COMMIT");
            return result;
          } catch (error) {
            pool.exec("ROLLBACK");
            throw error;
          }
        } finally {
          release();
        }
      }
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        try {
          const result = await fn(adapt(connection));
          await connection.query("COMMIT");
          return result;
        } catch (error) {
          await connection.query("ROLLBACK");
          throw error;
        }
      } finally {
        connection.release();
      }
    },
    async close() {
      if (engine === "sqlite") pool.close();
      else await pool.end();
    },
  };
  if (config.NODE_ENV === "production" && config.HEALTHPASS_RUN_MIGRATIONS !== "1") {
    await db.transaction(async (tx) => {
      if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='001'")))
        throw new Error(
          "Apply schema migration 001 using the migration identity before starting the API.",
        );
    });
    return db;
  }
  const schema = readFileSync(new URL("./migrations/001-foundation.sql", import.meta.url), "utf8");
  await db.transaction(async (tx) => {
    if (engine === "sqlite") pool.exec(schema);
    else await tx.run(schema);
    if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='001'"))) {
      if (engine === "sqlite") {
        pool.exec(`CREATE TRIGGER note_versions_no_update BEFORE UPDATE ON note_versions BEGIN SELECT RAISE(ABORT, 'Signed notes are immutable'); END;
          CREATE TRIGGER note_versions_no_delete BEFORE DELETE ON note_versions BEGIN SELECT RAISE(ABORT, 'Signed notes are immutable'); END;
          CREATE TRIGGER audits_no_update BEFORE UPDATE ON audits BEGIN SELECT RAISE(ABORT, 'Audit is append-only'); END;
          CREATE TRIGGER audits_no_delete BEFORE DELETE ON audits BEGIN SELECT RAISE(ABORT, 'Audit is append-only'); END;`);
      } else {
        await tx.run(`CREATE OR REPLACE FUNCTION hp_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Record is immutable'; END $$;
          CREATE TRIGGER note_versions_immutable BEFORE UPDATE OR DELETE ON note_versions FOR EACH ROW EXECUTE FUNCTION hp_immutable();
          CREATE TRIGGER audits_immutable BEFORE UPDATE OR DELETE ON audits FOR EACH ROW EXECUTE FUNCTION hp_immutable();`);
      }
      await tx.run("INSERT INTO schema_migrations(version) VALUES ('001')");
    }
  });
  return db;
}
