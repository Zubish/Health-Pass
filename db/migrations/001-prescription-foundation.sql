BEGIN;
CREATE TABLE IF NOT EXISTS healthpass_workspaces (
  organization_id text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state->>'organizationId' = organization_id),
  CHECK (state->>'schemaVersion' = '1')
);
ALTER TABLE healthpass_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE healthpass_workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS healthpass_organization_scope ON healthpass_workspaces;
CREATE POLICY healthpass_organization_scope ON healthpass_workspaces
  USING (organization_id = current_setting('healthpass.organization_id', true))
  WITH CHECK (organization_id = current_setting('healthpass.organization_id', true));
COMMIT;
-- Use a restricted non-superuser, non-BYPASSRLS application role.
-- Signing, consent, inbox and outbox changes share one locked workspace transaction.
-- This pilot stores one organization per row; normalize tables before broad scale.
