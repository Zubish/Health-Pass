-- Registration invitation only: never merges identities or transfers old records.
CREATE TABLE patient_link_invitations (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  grantor_id TEXT NOT NULL REFERENCES users(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  code_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  redeemed_at TEXT,
  redeemed_by TEXT REFERENCES users(id),
  review_reference TEXT NOT NULL DEFAULT ''
);
CREATE INDEX patient_link_invitation_owner ON patient_link_invitations(patient_id,created_at);
CREATE INDEX patient_link_invitation_facility ON patient_link_invitations(organization_id,branch_id);
-- Production migration identity separately grants runtime role:
-- GRANT SELECT, INSERT, UPDATE ON patient_link_invitations TO healthpass_app;
