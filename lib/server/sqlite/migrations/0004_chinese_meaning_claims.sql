CREATE TABLE chinese_meaning_claims (
  knowledge_point_id TEXT PRIMARY KEY NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'complete', 'failed')),
  lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
