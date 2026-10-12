import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { upgradeVisitRoles, upgradePrimaryRoles, upgradeCareResponsibilities } from "./roles.mjs";

export async function openDatabase(config = process.env, dependencies = {}) {
  let engine, pool;
  if (config.DATABASE_URL) {
    const { Pool } = await import("pg");
    pool = dependencies.pool ?? new Pool({ connectionString: config.DATABASE_URL });
    engine = "postgres";
  } else {
    if (config.NODE_ENV === "production") throw new Error("Production requires DATABASE_URL.");
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
      if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='012'")))
        throw new Error(
          "Apply schema migrations 001 through 012 using the migration identity before starting the API.",
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
  const workspaceSchema = readFileSync(
    new URL("./migrations/002-workspaces.sql", import.meta.url),
    "utf8",
  );
  await db.transaction(async (tx) => {
    if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='002'"))) {
      if (engine === "sqlite") pool.exec(workspaceSchema);
      else await tx.run(workspaceSchema);
      await tx.run("INSERT INTO schema_migrations(version) VALUES ('002')");
    }
  });
  await db.transaction(async (tx) => {
    if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='003'"))) {
      const idleSchema = readFileSync(
        new URL("./migrations/003-session-idle.sql", import.meta.url),
        "utf8",
      );
      if (engine === "sqlite") pool.exec(idleSchema);
      else await tx.run(idleSchema);
      await tx.run("INSERT INTO schema_migrations(version) VALUES ('003')");
    }
  });
  await db.transaction(async (tx) => {
    if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='004'"))) {
      const optionalSchema = readFileSync(
        new URL("./migrations/004-optional-authenticator.sql", import.meta.url),
        "utf8",
      );
      if (engine === "sqlite") pool.exec(optionalSchema);
      else await tx.run(optionalSchema);
      await tx.run("INSERT INTO schema_migrations(version) VALUES ('004')");
    }
  });
  await db.transaction(async (tx) => {
    if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='005'"))) {
      const roleSchema = readFileSync(
        new URL("./migrations/005-workspace-roles.sql", import.meta.url),
        "utf8",
      );
      if (engine === "sqlite") pool.exec(roleSchema);
      else await tx.run(roleSchema);
      await tx.run("INSERT INTO schema_migrations(version) VALUES ('005')");
    }
  });
  await db.transaction(async (tx) => {
    if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='006'"))) {
      const preferenceSchema = readFileSync(
        new URL("./migrations/006-authenticator-preference.sql", import.meta.url),
        "utf8",
      );
      if (engine === "sqlite") pool.exec(preferenceSchema);
      else await tx.run(preferenceSchema);
      await tx.run("INSERT INTO schema_migrations(version) VALUES ('006')");
    }
  });
  for (const [version, file] of [
    ["007", "007-patient-link-invitations.sql"],
    ["008", "008-care-visits.sql"],
    ["009", "009-professional-access.sql"],
    ["010", "010-care-handoffs.sql"],
    ["011", "011-patient-onboarding.sql"],
    ["012", "012-care-responsibilities.sql"],
  ]) {
    await db.transaction(async (tx) => {
      if (!(await tx.get("SELECT version FROM schema_migrations WHERE version=?", [version]))) {
        const schema = readFileSync(new URL("./migrations/" + file, import.meta.url), "utf8");
        if (engine === "sqlite") pool.exec(schema);
        else await tx.run(schema);
        if (version === "008") {
          await upgradeVisitRoles(tx);
          for (const table of ["visit_events", "visit_observations"]) {
            if (engine === "sqlite") {
              pool.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'Visit record is immutable'); END;
                CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'Visit record is immutable'); END;`);
            } else {
              await tx.run(
                `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION hp_immutable()`,
              );
            }
          }
        }
        if (version === "011") await upgradePrimaryRoles(tx);
        if (version === "012") {
          await upgradeCareResponsibilities(tx);
          if (engine === "sqlite")
            pool.exec(
              "CREATE TRIGGER care_responsibility_events_no_update BEFORE UPDATE ON care_responsibility_events BEGIN SELECT RAISE(ABORT, 'Care responsibility history is immutable'); END; CREATE TRIGGER care_responsibility_events_no_delete BEFORE DELETE ON care_responsibility_events BEGIN SELECT RAISE(ABORT, 'Care responsibility history is immutable'); END;",
            );
          else
            await tx.run(
              "CREATE TRIGGER care_responsibility_events_immutable BEFORE UPDATE OR DELETE ON care_responsibility_events FOR EACH ROW EXECUTE FUNCTION hp_immutable()",
            );
        }
        await tx.run("INSERT INTO schema_migrations(version) VALUES (?)", [version]);
      }
    });
  }
  return db;
}
