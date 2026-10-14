import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./store.mjs";

const databaseUrl = process.env.HEALTHPASS_TEST_DATABASE_URL;
test(
  "PostgreSQL migration, RLS, rollback and concurrent durable inbox/outbox transactions",
  {
    skip:
      !databaseUrl &&
      "Set HEALTHPASS_TEST_DATABASE_URL for an isolated migrated PostgreSQL database",
  },
  async () => {
    const prefix = `test-${Date.now()}`;
    const a = await openStore({ production: true, databaseUrl, organizationId: `${prefix}-a` });
    const b = await openStore({ production: true, databaseUrl, organizationId: `${prefix}-b` });
    try {
      await a.transact((state) => {
        state.audit.push({ id: "initial" });
        state.outbox.push({ id: "signed-event", status: "queued" });
      });
      await b.transact((state) => {
        state.audit.push({ id: "other-organization" });
      });
      await Promise.all(
        Array.from({ length: 10 }, (_, n) =>
          a.transact((state) => {
            state.inbox.push({ eventId: `event-${n}` });
            state.audit.push({ id: `transaction-${n}` });
          }),
        ),
      );
      assert.equal(await a.transact((s) => s.inbox.length), 10);
      assert.equal(await b.transact((s) => s.inbox.length), 0);
      await assert.rejects(
        a.transact((state) => {
          state.inbox.length = 0;
          state.outbox.length = 0;
          throw Error("Atomic failure");
        }),
      );
      assert.equal(await a.transact((s) => s.inbox.length), 10);
      assert.equal(await a.transact((s) => s.outbox[0].id), "signed-event");
      const { Pool } = await import("pg"),
        pool = new Pool({ connectionString: databaseUrl });
      try {
        const client = await pool.connect();
        try {
          assert.equal((await client.query("SELECT * FROM healthpass_workspaces")).rows.length, 0);
          await client.query("BEGIN");
          await client.query("SELECT set_config('healthpass.organization_id', $1, true)", [
            `${prefix}-a`,
          ]);
          const rows = (await client.query("SELECT organization_id FROM healthpass_workspaces"))
            .rows;
          assert.deepEqual(
            rows.map((r) => r.organization_id),
            [`${prefix}-a`],
          );
          await assert.rejects(
            client.query(
              "INSERT INTO healthpass_workspaces (organization_id,state) VALUES ($1,$2::jsonb)",
              [
                `${prefix}-forbidden`,
                JSON.stringify({ schemaVersion: 1, organizationId: `${prefix}-forbidden` }),
              ],
            ),
            /row-level security/,
          );
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    } finally {
      await a.close();
      await b.close();
    }
  },
);
