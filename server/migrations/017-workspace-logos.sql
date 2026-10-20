CREATE TABLE workspace_logos (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  image_data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
