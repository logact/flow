CREATE TABLE material_analysis_candidate_claims (
  analysis_id TEXT NOT NULL REFERENCES material_analyses(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  lemma TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'resolved', 'failed')),
  lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (analysis_id, lemma)
);
