CREATE INDEX events_by_word_time ON events(word_id,ts);

CREATE INDEX materials_lookup ON materials(word_id,axis,stage,status);

CREATE UNIQUE INDEX one_attempt_id_per_instance ON attempts(instance_id,attempt_id);

CREATE UNIQUE INDEX one_frozen_attempt_per_instance ON attempts(instance_id) WHERE status IN ('frozen','grading_retry','completed','exited');

CREATE UNIQUE INDEX one_live_instance ON task_instances((1)) WHERE status IN ('issued','grading','grading_retry');

CREATE TABLE attempts (
    attempt_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL REFERENCES task_instances(instance_id),
    response_json TEXT NOT NULL,
    timing_json TEXT NOT NULL,
    exposure_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('frozen','completed','grading_retry','invalid','exited')),
    grading_attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    instance_id TEXT,
    attempt_id TEXT,
    word_id INTEGER,
    axis TEXT,
    ts INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  );

CREATE TABLE materials (
    id TEXT PRIMARY KEY,
    word_id INTEGER NOT NULL REFERENCES words(id),
    axis TEXT NOT NULL CHECK(axis IN ('r','p')),
    stage TEXT NOT NULL CHECK(stage IN ('encode','choice','cued','free','fluency')),
    version INTEGER NOT NULL,
    meaning_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('preparing','ready','failed','invalidated')),
    public_payload TEXT NOT NULL,
    answer_key TEXT NOT NULL,
    grading_requirements TEXT NOT NULL,
    timing_protocol TEXT NOT NULL,
    validation_json TEXT NOT NULL,
    generation_attempts INTEGER NOT NULL DEFAULT 0,
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(word_id,axis,stage,version),
    UNIQUE(id,version)
  );

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE task_instances (
    instance_id TEXT PRIMARY KEY,
    definition_id TEXT NOT NULL,
    word_id INTEGER NOT NULL REFERENCES words(id),
    axis TEXT NOT NULL CHECK(axis IN ('r','p')),
    type TEXT NOT NULL CHECK(type IN ('ENCODE','RETRIEVE','FLUENCY')),
    stage TEXT NOT NULL CHECK(stage IN ('encode','choice','cued','free','fluency')),
    purpose TEXT NOT NULL CHECK(purpose IN ('introduce','review','recover')),
    score_before REAL NOT NULL,
    material_id TEXT NOT NULL REFERENCES materials(id),
    material_version INTEGER NOT NULL,
    meaning_version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('issued','grading','grading_retry','completed','skipped','exited','invalid')),
    issued_at INTEGER NOT NULL,
    terminal_at INTEGER,
    FOREIGN KEY(material_id,material_version) REFERENCES materials(id,version)
  );

CREATE TABLE words (
    id INTEGER PRIMARY KEY,
    term TEXT NOT NULL,
    meaning TEXT NOT NULL,
    meaning_version INTEGER NOT NULL DEFAULT 1,
    target_r REAL NOT NULL CHECK(target_r BETWEEN 60 AND 100),
    target_p REAL NOT NULL CHECK(target_p BETWEEN 60 AND 100),
    score_r REAL NOT NULL DEFAULT 0 CHECK(score_r BETWEEN 0 AND 100),
    score_p REAL NOT NULL DEFAULT 0 CHECK(score_p BETWEEN 0 AND 100),
    introduced INTEGER NOT NULL DEFAULT 0 CHECK(introduced IN (0,1)),
    observation_r INTEGER NOT NULL DEFAULT 0 CHECK(observation_r IN (0,1)),
    observation_p INTEGER NOT NULL DEFAULT 0 CHECK(observation_p IN (0,1)),
    half_life_r REAL NOT NULL DEFAULT 3600000 CHECK(half_life_r > 0),
    half_life_p REAL NOT NULL DEFAULT 3600000 CHECK(half_life_p > 0),
    last_ts_r INTEGER,
    last_ts_p INTEGER,
    last_ts_any INTEGER,
    last_tick_any INTEGER,
    freq REAL,
    freq_source TEXT,
    level TEXT NOT NULL DEFAULT 'B1' CHECK(level IN ('A1','A2','B1','B2','C1','C2')),
    created_at INTEGER NOT NULL
  );
