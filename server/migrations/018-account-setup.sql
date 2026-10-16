CREATE TABLE account_setup (
  user_id TEXT NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL,
  reviewed TEXT NOT NULL DEFAULT '[]',
  dismissed INTEGER NOT NULL DEFAULT 0 CHECK(dismissed IN (0,1)),
  snoozed_until TEXT,
  presented_at TEXT,
  presented_phase TEXT NOT NULL DEFAULT 'none',
  PRIMARY KEY(user_id,scope)
);
