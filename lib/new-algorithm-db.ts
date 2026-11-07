import Database from 'better-sqlite3';

export const NEW_ALGORITHM_SCHEMA_VERSION = 2;

const schema = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY,
    term TEXT NOT NULL,
    meaning TEXT NOT NULL,
    meaning_version INTEGER NOT NULL DEFAULT 1,
    target_r REAL NOT NULL CHECK(target_r BETWEEN 60 AND 100),
    target_p REAL NOT NULL CHECK(target_p BETWEEN 60 AND 100),
    score_r REAL NOT NULL DEFAULT 0 CHECK(score_r BETWEEN 0 AND 100),
    score_p REAL NOT NULL DEFAULT 0 CHECK(score_p BETWEEN 0 AND 100),
    introduced INTEGER NOT NULL DEFAULT 0 CHECK(introduced IN (0,1)),
    fluency_pass_r INTEGER NOT NULL DEFAULT 0 CHECK(fluency_pass_r IN (0,1)),
    fluency_pass_p INTEGER NOT NULL DEFAULT 0 CHECK(fluency_pass_p IN (0,1)),
    learning_complete_r INTEGER NOT NULL DEFAULT 0 CHECK(learning_complete_r IN (0,1)),
    learning_complete_p INTEGER NOT NULL DEFAULT 0 CHECK(learning_complete_p IN (0,1)),
    review_level_r INTEGER CHECK(review_level_r IN (1,3,7,30)),
    review_level_p INTEGER CHECK(review_level_p IN (1,3,7,30)),
    graduated_r INTEGER NOT NULL DEFAULT 0 CHECK(graduated_r IN (0,1)),
    graduated_p INTEGER NOT NULL DEFAULT 0 CHECK(graduated_p IN (0,1)),
    graduated INTEGER NOT NULL DEFAULT 0 CHECK(graduated IN (0,1)),
    due_at_r TEXT,
    due_at_p TEXT,
    local_timezone TEXT NOT NULL,
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
  CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    word_id INTEGER NOT NULL REFERENCES words(id),
    axis TEXT NOT NULL CHECK(axis IN ('r','p','both')),
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
    CHECK((stage='encode' AND axis='both') OR (stage<>'encode' AND axis IN ('r','p'))),
    UNIQUE(word_id,axis,stage,version),
    UNIQUE(id,version,word_id,axis,stage)
  );
  CREATE INDEX IF NOT EXISTS materials_lookup ON materials(word_id,axis,stage,status);
  CREATE TABLE IF NOT EXISTS task_instances (
    instance_id TEXT PRIMARY KEY,
    definition_id TEXT NOT NULL,
    word_id INTEGER NOT NULL REFERENCES words(id),
    axis TEXT NOT NULL CHECK(axis IN ('r','p','both')),
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
    CHECK((type='ENCODE' AND axis='both' AND stage='encode') OR (type<>'ENCODE' AND axis IN ('r','p') AND stage<>'encode')),
    FOREIGN KEY(material_id,material_version,word_id,axis,stage) REFERENCES materials(id,version,word_id,axis,stage)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_live_instance ON task_instances((1)) WHERE status IN ('issued','grading','grading_retry');
  CREATE UNIQUE INDEX IF NOT EXISTS one_completed_connection_per_word ON task_instances(word_id) WHERE axis='both' AND type='ENCODE' AND status='completed';
  CREATE TABLE IF NOT EXISTS attempts (
    attempt_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL REFERENCES task_instances(instance_id),
    response_json TEXT NOT NULL,
    timing_json TEXT NOT NULL,
    exposure_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('frozen','completed','grading_retry','invalid','exited')),
    grading_attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_attempt_per_instance ON attempts(instance_id) WHERE status IN ('frozen','grading_retry');
  CREATE UNIQUE INDEX IF NOT EXISTS one_completed_attempt_per_instance ON attempts(instance_id) WHERE status='completed';
  CREATE UNIQUE INDEX IF NOT EXISTS one_attempt_id_per_instance ON attempts(instance_id,attempt_id);
  CREATE TABLE IF NOT EXISTS events (
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
  CREATE INDEX IF NOT EXISTS events_by_word_time ON events(word_id,ts);
  CREATE TABLE IF NOT EXISTS daily_capacity (
    local_date TEXT NOT NULL,
    timezone TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK(capacity >= 0),
    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed >= 0),
    PRIMARY KEY(local_date, timezone)
  );
  CREATE TABLE IF NOT EXISTS capacity_reservations (
    reservation_id TEXT PRIMARY KEY,
    word_id INTEGER NOT NULL REFERENCES words(id),
    axis TEXT NOT NULL CHECK(axis IN ('r','p')),
    local_date TEXT NOT NULL,
    timezone TEXT NOT NULL,
    reservation_kind TEXT NOT NULL CHECK(reservation_kind IN ('determined','conditional')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','consumed')),
    UNIQUE(word_id, axis, local_date, timezone, reservation_kind)
  );
  CREATE INDEX IF NOT EXISTS reservations_by_day ON capacity_reservations(local_date,timezone,status);
`;

export function initializeNewAlgorithmDb(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (existing) {
      const version = db.prepare("SELECT value FROM meta WHERE key='new_algorithm_schema'").get() as {value:string}|undefined;
      if (!version || Number(version.value) !== NEW_ALGORITHM_SCHEMA_VERSION) {
        throw new Error('Refusing to initialize an unversioned or incompatible database');
      }
    } else {
      const foreignTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (foreignTables.length) throw new Error('Refusing to initialize a nonempty database');
    }
    db.exec(schema);
    const current = db.prepare("SELECT value FROM meta WHERE key='new_algorithm_schema'").get() as {value:string}|undefined;
    if (current && Number(current.value) !== NEW_ALGORITHM_SCHEMA_VERSION) throw new Error(`Unsupported new algorithm schema version: ${current.value}`);
    db.prepare("INSERT INTO meta(key,value) VALUES('new_algorithm_schema',?) ON CONFLICT(key) DO NOTHING").run(String(NEW_ALGORITHM_SCHEMA_VERSION));
    db.prepare("INSERT INTO meta(key,value) VALUES('global_tick','0') ON CONFLICT(key) DO NOTHING").run();
  })();
}

export function createNewAlgorithmDb(file = ':memory:'): Database.Database {
  const db = new Database(file);
  try {
    initializeNewAlgorithmDb(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
