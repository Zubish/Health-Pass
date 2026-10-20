import { proxyGuards } from "./proxy-schema.mjs";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  upgradeVisitRoles,
  upgradePrimaryRoles,
  upgradeCareResponsibilities,
  roleTemplates,
} from "./roles.mjs";

export async function openDatabase(config = process.env, dependencies = {}) {
  let engine;
  let pool;
  if (config.DATABASE_URL) {
    const { Pool } = await import("pg");
    pool = dependencies.pool ?? new Pool({ connectionString: config.DATABASE_URL });
    engine = "postgres";
  } else {
    if (config.NODE_ENV === "production") {
      throw new Error("Production requires DATABASE_URL.");
    }
    const path =
      config.HEALTHPASS_SQLITE_PATH ||
      fileURLToPath(new URL("../.data/healthpass.sqlite", import.meta.url));
    if (path !== ":memory:") {
      await mkdir(dirname(path), { recursive: true });
    }
    const { DatabaseSync } = await import("node:sqlite");
    pool = new DatabaseSync(path);
    pool.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    engine = "sqlite";
  }
  const adapt = (connection) => ({
    async all(sql, args = []) {
      if (engine === "sqlite") {
        return connection.prepare(sql).all(...args);
      }
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
      if (engine === "sqlite") {
        return connection.prepare(sql).run(...args);
      }
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
      if (engine === "sqlite") {
        pool.close();
      } else {
        await pool.end();
      }
    },
  };
  if (config.NODE_ENV === "production" && config.HEALTHPASS_RUN_MIGRATIONS !== "1") {
    await db.transaction(async (tx) => {
      if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='021'"))) {
        throw new Error(
          "Apply schema migrations 001 through 021 using the migration identity before starting the API.",
        );
      }
    });
    return db;
  }
  const schema = readFileSync(new URL("./migrations/001-foundation.sql", import.meta.url), "utf8");
  await db.transaction(async (tx) => {
    if (engine === "sqlite") {
      pool.exec(schema);
    } else {
      await tx.run(schema);
    }
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
      if (engine === "sqlite") {
        pool.exec(workspaceSchema);
      } else {
        await tx.run(workspaceSchema);
      }
      await tx.run("INSERT INTO schema_migrations(version) VALUES ('002')");
    }
  });
  await db.transaction(async (tx) => {
    if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='003'"))) {
      const idleSchema = readFileSync(
        new URL("./migrations/003-session-idle.sql", import.meta.url),
        "utf8",
      );
      if (engine === "sqlite") {
        pool.exec(idleSchema);
      } else {
        await tx.run(idleSchema);
      }
      await tx.run("INSERT INTO schema_migrations(version) VALUES ('003')");
    }
  });
  await db.transaction(async (tx) => {
    if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='004'"))) {
      const optionalSchema = readFileSync(
        new URL("./migrations/004-optional-authenticator.sql", import.meta.url),
        "utf8",
      );
      if (engine === "sqlite") {
        pool.exec(optionalSchema);
      } else {
        await tx.run(optionalSchema);
      }
      await tx.run("INSERT INTO schema_migrations(version) VALUES ('004')");
    }
  });
  await db.transaction(async (tx) => {
    if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='005'"))) {
      const roleSchema = readFileSync(
        new URL("./migrations/005-workspace-roles.sql", import.meta.url),
        "utf8",
      );
      if (engine === "sqlite") {
        pool.exec(roleSchema);
      } else {
        await tx.run(roleSchema);
      }
      await tx.run("INSERT INTO schema_migrations(version) VALUES ('005')");
    }
  });
  await db.transaction(async (tx) => {
    if (!(await tx.get("SELECT version FROM schema_migrations WHERE version='006'"))) {
      const preferenceSchema = readFileSync(
        new URL("./migrations/006-authenticator-preference.sql", import.meta.url),
        "utf8",
      );
      if (engine === "sqlite") {
        pool.exec(preferenceSchema);
      } else {
        await tx.run(preferenceSchema);
      }
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
    ["013", "013-care-operations.sql"],
    ["014", "014-clinical-treatment-security.sql"],
    ["015", "015-department-workflows.sql"],
    ["016", "016-user-preferences.sql"],
    ["017", "017-workspace-logos.sql"],
    ["018", "018-account-setup.sql"],
    ["019", "019-emergency-proxies.sql"],
    ["020", "020-ward-management.sql"],
    ["021", "021-remembered-devices.sql"],
  ]) {
    await db.transaction(async (tx) => {
      if (!(await tx.get("SELECT version FROM schema_migrations WHERE version=?", [version]))) {
        const schema = readFileSync(new URL("./migrations/" + file, import.meta.url), "utf8");
        if (engine === "sqlite") {
          pool.exec(schema);
        } else {
          await tx.run(schema);
        }
        if (version === "015") {
          for (const org of await tx.all("SELECT id FROM organizations")) {
            for (const role of roleTemplates.filter((r) =>
              ["laboratory", "radiology", "radiographer"].includes(r.key),
            )) {
              await tx.run(
                "INSERT INTO workspace_roles(id,organization_id,name,description,template_key,clinical_scope,permissions) VALUES (?,?,?,?,?,?,?) ON CONFLICT(organization_id,name) DO NOTHING",
                [
                  "role-" + org.id + "-" + role.key,
                  org.id,
                  role.name,
                  role.description,
                  role.key,
                  role.clinical_scope,
                  JSON.stringify(role.permissions),
                ],
              );
            }
          }
          for (const table of ["department_events", "department_reports"]) {
            if (engine === "sqlite") {
              pool.exec(
                `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Department history is immutable'); END; CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Department history is immutable'); END;`,
              );
            } else {
              await tx.run(
                `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION hp_immutable()`,
              );
            }
          }
        }
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
        if (version === "011") {
          await upgradePrimaryRoles(tx);
        }
        if (version === "012") {
          await upgradeCareResponsibilities(tx);
          if (engine === "sqlite") {
            pool.exec(
              "CREATE TRIGGER care_responsibility_events_no_update BEFORE UPDATE ON care_responsibility_events BEGIN SELECT RAISE(ABORT, 'Care responsibility history is immutable'); END; CREATE TRIGGER care_responsibility_events_no_delete BEFORE DELETE ON care_responsibility_events BEGIN SELECT RAISE(ABORT, 'Care responsibility history is immutable'); END;",
            );
          } else {
            await tx.run(
              "CREATE TRIGGER care_responsibility_events_immutable BEFORE UPDATE OR DELETE ON care_responsibility_events FOR EACH ROW EXECUTE FUNCTION hp_immutable()",
            );
          }
        }
        if (version === "013") {
          if (engine === "sqlite") {
            pool.exec(
              "CREATE TRIGGER care_workflow_events_no_update BEFORE UPDATE ON care_workflow_events BEGIN SELECT RAISE(ABORT, 'Care workflow history is immutable'); END; CREATE TRIGGER care_workflow_events_no_delete BEFORE DELETE ON care_workflow_events BEGIN SELECT RAISE(ABORT, 'Care workflow history is immutable'); END;",
            );
          } else {
            await tx.run(
              "CREATE TRIGGER care_workflow_events_immutable BEFORE UPDATE OR DELETE ON care_workflow_events FOR EACH ROW EXECUTE FUNCTION hp_immutable()",
            );
          }
        }
        if (version === "014") {
          if (engine === "sqlite") {
            pool.exec(
              "CREATE TRIGGER medication_orders_signed_update BEFORE UPDATE ON medication_orders WHEN OLD.id IS NOT NEW.id OR OLD.patient_id IS NOT NEW.patient_id OR OLD.organization_id IS NOT NEW.organization_id OR OLD.branch_id IS NOT NEW.branch_id OR OLD.admission_id IS NOT NEW.admission_id OR OLD.prescriber_id IS NOT NEW.prescriber_id OR OLD.medicine IS NOT NEW.medicine OR OLD.dose IS NOT NEW.dose OR OLD.route IS NOT NEW.route OR OLD.frequency IS NOT NEW.frequency OR OLD.interval_hours IS NOT NEW.interval_hours OR OLD.prn IS NOT NEW.prn OR OLD.indication IS NOT NEW.indication OR OLD.instructions IS NOT NEW.instructions OR OLD.starts_at IS NOT NEW.starts_at OR OLD.ends_at IS NOT NEW.ends_at OR OLD.created_at IS NOT NEW.created_at OR OLD.request_key IS NOT NEW.request_key OR OLD.request_payload IS NOT NEW.request_payload BEGIN SELECT RAISE(ABORT,'Signed prescriptions cannot be rewritten'); END; CREATE TRIGGER medication_orders_no_delete BEFORE DELETE ON medication_orders BEGIN SELECT RAISE(ABORT,'Signed prescriptions cannot be deleted'); END;",
            );
          } else {
            await tx.run(
              "CREATE FUNCTION hp_prescription_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Signed prescriptions cannot be deleted'; END IF; IF (to_jsonb(NEW)-'status'-'version'-'stopped_at'-'stop_reason') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'version'-'stopped_at'-'stop_reason') THEN RAISE EXCEPTION 'Signed prescriptions cannot be rewritten'; END IF; RETURN NEW; END $$",
            );
            await tx.run(
              "CREATE TRIGGER medication_orders_signed BEFORE UPDATE OR DELETE ON medication_orders FOR EACH ROW EXECUTE FUNCTION hp_prescription_immutable()",
            );
          }
          for (const table of [
            "account_activity",
            "clinical_admission_decisions",
            "medication_administrations",
            "ward_observations",
            "treatment_events",
          ]) {
            if (engine === "sqlite") {
              pool.exec(
                `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Treatment history is immutable'); END; CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Treatment history is immutable'); END;`,
              );
            } else {
              await tx.run(
                `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION hp_immutable()`,
              );
            }
          }
        }
        if (version === "019") {
          const roles = await tx.all(
            "SELECT id,permissions FROM workspace_roles WHERE template_key IN ('gp','consultant','clinician','nurse')",
          );
          for (const role of roles) {
            await tx.run("UPDATE workspace_roles SET permissions=? WHERE id=?", [
              JSON.stringify([...new Set([...JSON.parse(role.permissions), "emergency.request"])]),
              role.id,
            ]);
          }
          for (const sql of proxyGuards(engine)) {
            await tx.run(sql);
          }
        }
        await tx.run("INSERT INTO schema_migrations(version) VALUES (?)", [version]);
      }
    });
  }
  return db;
}
