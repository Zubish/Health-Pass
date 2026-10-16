CREATE TABLE patient_access_settings (
  patient_id TEXT PRIMARY KEY REFERENCES patients(id),
  restricted INTEGER NOT NULL DEFAULT 0 CHECK(restricted IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE TABLE professional_grants (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  recipient_user_id TEXT NOT NULL REFERENCES users(id),
  recipient_organization_id TEXT NOT NULL REFERENCES organizations(id),
  recipient_branch_id TEXT REFERENCES branches(id),
  grantor_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES professional_grants(id),
  scopes_json TEXT NOT NULL,
  include_profile INTEGER NOT NULL DEFAULT 0 CHECK(include_profile IN (0,1)),
  can_contribute INTEGER NOT NULL DEFAULT 0 CHECK(can_contribute IN (0,1)),
  allow_delegation INTEGER NOT NULL DEFAULT 0 CHECK(allow_delegation IN (0,1)),
  allow_external_delegation INTEGER NOT NULL DEFAULT 0 CHECK(allow_external_delegation IN (0,1)),
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  request_payload TEXT NOT NULL,
  UNIQUE(grantor_id,client_request_id)
);
CREATE INDEX professional_grant_recipient ON professional_grants(recipient_user_id,recipient_organization_id,patient_id);
CREATE INDEX professional_grant_patient ON professional_grants(patient_id,created_at);
CREATE INDEX professional_grant_parent ON professional_grants(parent_id);
ALTER TABLE visit_followups ADD COLUMN discipline TEXT NOT NULL DEFAULT 'unknown' CHECK(discipline IN ('general','nursing','medication','unknown'));
-- Migration identity grants SELECT,INSERT,UPDATE on both new tables to healthpass_app.
