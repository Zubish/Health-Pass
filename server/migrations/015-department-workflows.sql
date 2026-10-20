CREATE TABLE department_orders (
 id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), organization_id TEXT NOT NULL REFERENCES organizations(id), branch_id TEXT NOT NULL REFERENCES branches(id),
 department TEXT NOT NULL CHECK(department IN ('laboratory','radiology','pharmacy')), requested_by TEXT NOT NULL REFERENCES users(id), assigned_to TEXT REFERENCES users(id), medication_order_id TEXT REFERENCES medication_orders(id),
 service TEXT NOT NULL, indication TEXT NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('routine','urgent')), status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','accepted','in-progress','awaiting-report','reported','released','declined','cancelled')),
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, request_payload TEXT NOT NULL
);
CREATE INDEX department_queue ON department_orders(organization_id,branch_id,department,status,created_at);
CREATE INDEX department_patient ON department_orders(patient_id,created_at);
CREATE TABLE department_events (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES department_orders(id), actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, reason TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL,
 request_key TEXT NOT NULL UNIQUE, request_payload TEXT NOT NULL, UNIQUE(order_id,version)
);
CREATE TABLE department_reports (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES department_orders(id), author_id TEXT NOT NULL REFERENCES users(id), report TEXT NOT NULL, details TEXT NOT NULL, signed_at TEXT NOT NULL, amendment_reason TEXT NOT NULL DEFAULT '', previous_id TEXT REFERENCES department_reports(id)
);
