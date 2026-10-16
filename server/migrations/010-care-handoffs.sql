CREATE TABLE visit_handoffs (
 id TEXT PRIMARY KEY,
 visit_id TEXT NOT NULL REFERENCES care_visits(id),
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 branch_id TEXT NOT NULL REFERENCES branches(id),
 from_user_id TEXT NOT NULL REFERENCES users(id),
 to_user_id TEXT NOT NULL REFERENCES users(id),
 source_encounter_id TEXT NOT NULL REFERENCES encounters(id),
 source_version INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled')),
 pending_key TEXT UNIQUE,
 requested_visit_version INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 resolved_at TEXT,
 client_request_id TEXT NOT NULL,
 request_payload TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 UNIQUE(visit_id,from_user_id,client_request_id)
);
CREATE INDEX visit_handoff_participants ON visit_handoffs(organization_id,branch_id,to_user_id,status,expires_at);
CREATE INDEX visit_handoff_history ON visit_handoffs(visit_id,created_at,id);
-- Runtime grants: SELECT, INSERT, UPDATE ON visit_handoffs TO healthpass_app.
