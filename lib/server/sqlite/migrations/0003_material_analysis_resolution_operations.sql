CREATE TABLE material_analysis_resolution_operations (
  analysis_id TEXT NOT NULL REFERENCES material_analyses(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  lemmas_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'complete', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (analysis_id, operation_id)
);
CREATE TABLE material_analysis_resolution_locks (
  analysis_id TEXT PRIMARY KEY NOT NULL REFERENCES material_analyses(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  lease_until TEXT NOT NULL
);
