CREATE TABLE patient_proxies (
 id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id),
 proxy_user_id TEXT REFERENCES users(id), proxy_organization_id TEXT REFERENCES organizations(id),
 scopes_json TEXT NOT NULL, include_profile INTEGER NOT NULL DEFAULT 0,
 policy_version TEXT NOT NULL, consented_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','revoked')),
 decided_at TEXT, created_at TEXT NOT NULL,
 CHECK ((proxy_user_id IS NULL) <> (proxy_organization_id IS NULL))
);
CREATE INDEX patient_proxy_owner ON patient_proxies(patient_id,status);
CREATE INDEX patient_proxy_user ON patient_proxies(proxy_user_id,status);
CREATE INDEX patient_proxy_facility ON patient_proxies(proxy_organization_id,status);
CREATE TABLE emergency_requests (
 id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES patient_proxies(id),
 patient_id TEXT NOT NULL REFERENCES patients(id), requester_id TEXT NOT NULL REFERENCES users(id),
 organization_id TEXT NOT NULL REFERENCES organizations(id), branch_id TEXT REFERENCES branches(id),
 scopes_json TEXT NOT NULL, include_profile INTEGER NOT NULL DEFAULT 0,
 reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','declined','cancelled')),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, access_until TEXT,
 decided_by TEXT REFERENCES users(id), decision_reason TEXT, decided_at TEXT
);
CREATE INDEX emergency_proxy_pending ON emergency_requests(appointment_id,status);
CREATE TABLE proxy_event_heads (patient_id TEXT PRIMARY KEY REFERENCES patients(id), sequence INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL DEFAULT '');
CREATE TABLE proxy_events (
 id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), sequence INTEGER NOT NULL,
 resource_id TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), organization_id TEXT REFERENCES organizations(id),
 action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL,
 previous_hash TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE(patient_id,sequence)
);
CREATE TABLE proxy_event_receipts (user_id TEXT NOT NULL REFERENCES users(id), event_id TEXT NOT NULL REFERENCES proxy_events(id), PRIMARY KEY(user_id,event_id));
