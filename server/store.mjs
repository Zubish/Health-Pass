import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function emptyState(organizationId) {
  return {
    schemaVersion: 1,
    organizationId,
    users: [],
    patients: [],
    encounters: [],
    consents: [],
    prescriptions: [],
    sessions: [],
    audit: [],
    outbox: [],
    inbox: [],
    raiGrants: [],
    loginAttempts: [],
  };
}

// A test adapter only. The runtime never selects this for a deployed service.
export function memoryStore(initial) {
  let value = structuredClone(initial),
    tail = Promise.resolve();
  return {
    transact(fn) {
      const run = tail.then(async () => {
        const draft = structuredClone(value);
        const result = await fn(draft);
        value = draft;
        return structuredClone(result);
      });
      tail = run.catch(() => {});
      return run;
    },
  };
}

export async function openStore(config) {
  if (config.databaseUrl) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
    return {
      async transact(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('healthpass.organization_id', $1, true)", [
            config.organizationId,
          ]);
          await client.query(
            "INSERT INTO healthpass_workspaces (organization_id, state) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING",
            [config.organizationId, JSON.stringify(emptyState(config.organizationId))],
          );
          const { rows } = await client.query(
            "SELECT state FROM healthpass_workspaces WHERE organization_id = $1 FOR UPDATE",
            [config.organizationId],
          );
          if (!rows[0]) throw new Error("Workspace unavailable");
          const result = await fn(rows[0].state);
          await client.query(
            "UPDATE healthpass_workspaces SET state = $2::jsonb, updated_at = now() WHERE organization_id = $1",
            [config.organizationId, JSON.stringify(rows[0].state)],
          );
          await client.query("COMMIT");
          return structuredClone(result);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (config.production) throw new Error("Production requires an approved PostgreSQL DATABASE_URL");
  const { DatabaseSync } = await import("node:sqlite");
  const path = config.sqlitePath || ".healthpass/development.sqlite";
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, state TEXT NOT NULL)",
  );
  db.prepare("INSERT OR IGNORE INTO workspaces VALUES (?, ?)").run(
    config.organizationId,
    JSON.stringify(emptyState(config.organizationId)),
  );
  let tail = Promise.resolve();
  return {
    transact(fn) {
      const run = tail.then(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const state = JSON.parse(
            db.prepare("SELECT state FROM workspaces WHERE id = ?").get(config.organizationId)
              .state,
          );
          const result = await fn(state);
          db.prepare("UPDATE workspaces SET state = ? WHERE id = ?").run(
            JSON.stringify(state),
            config.organizationId,
          );
          db.exec("COMMIT");
          return structuredClone(result);
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      tail = run.catch(() => {});
      return run;
    },
    close: () => db.close(),
  };
}

export const newId = (prefix) => `${prefix}_${randomUUID()}`;
