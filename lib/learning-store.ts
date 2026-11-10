import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createGoals, updateGoals, type GoalSet } from './goals';
import { schedule, type FluencyTestResult, type ScheduleEvent, type WordSchedule } from './schedule';
import type { Axis, ScoreEvent } from './scoring';

export interface LearningWord {
  id: string;
  text: string;
  band: string;
  rank: number | null;
  rankSource: { id: string; basis: string } | null;
  sense: { id: string; definition: string; partOfSpeech?: string };
  state: WordSchedule;
  metadata?: Record<string, unknown>;
}

export interface LearningTask {
  taskId: string;
  userId: string;
  wordId: string;
  axis: Axis | 'both';
  type: 'ENCODE' | 'RETRIEVE' | 'FLUENCY';
  date: string;
  payload: unknown;
}

export interface LearningSnapshot {
  userId: string;
  goals: GoalSet;
  words: LearningWord[];
  completedToday: number;
}

export interface FluencySettlement {
  attemptId: string;
  taskId: string;
  userId: string;
  wordId: string;
  date: string;
  result: FluencyTestResult;
  submission: unknown;
  grade: unknown;
}

/** SQLite source of truth for learning state. Each accepted settlement updates the word, attempt, and daily count atomically. */
export class SqliteLearningStore {
  private readonly db: InstanceType<typeof Database>;

  constructor(filename = process.env.FLOW_DB_PATH ?? 'data/flow.sqlite') {
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learning_users (
        user_id TEXT PRIMARY KEY, goals_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS learning_words (
        user_id TEXT NOT NULL, word_id TEXT NOT NULL, word_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, word_id),
        FOREIGN KEY (user_id) REFERENCES learning_users(user_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS learning_tasks (
        task_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, word_id TEXT NOT NULL,
        task_date TEXT NOT NULL, task_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (user_id, word_id) REFERENCES learning_words(user_id, word_id)
      );
      CREATE TABLE IF NOT EXISTS learning_attempts (
        attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
        word_id TEXT NOT NULL, task_date TEXT NOT NULL, status TEXT NOT NULL,
        attempt_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES learning_tasks(task_id),
        FOREIGN KEY (user_id, word_id) REFERENCES learning_words(user_id, word_id)
      );
      CREATE TABLE IF NOT EXISTS learning_daily_counts (
        user_id TEXT NOT NULL, task_date TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, task_date),
        FOREIGN KEY (user_id) REFERENCES learning_users(user_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS learning_tasks_user_date ON learning_tasks(user_id, task_date);
      CREATE INDEX IF NOT EXISTS learning_attempts_user_date ON learning_attempts(user_id, task_date);
    `);
  }

  createUser(userId: string, goals: Partial<GoalSet> = {}, now = new Date().toISOString()): GoalSet {
    requireId(userId, 'userId');
    const normalized = createGoals(goals);
    this.db.prepare('INSERT OR IGNORE INTO learning_users (user_id, goals_json, created_at) VALUES (?, ?, ?)')
      .run(userId, json(normalized), now);
    return this.getGoals(userId);
  }

  getGoals(userId: string): GoalSet {
    const row = this.db.prepare('SELECT goals_json FROM learning_users WHERE user_id = ?').get(userId) as { goals_json: string } | undefined;
    if (!row) throw new Error(`Learning user not found: ${userId}`);
    return parse<GoalSet>(row.goals_json);
  }

  setGoals(userId: string, goals: GoalSet, date: string): LearningSnapshot {
    return this.db.transaction(() => {
      const current = this.getGoals(userId);
      const words = this.listWords(userId);
      const updated = updateGoals({ current, next: goals, date, words: words.map(word => ({ id: word.id, state: word.state })), logger: () => undefined });
      this.db.prepare('UPDATE learning_users SET goals_json = ? WHERE user_id = ?').run(json(updated.goals), userId);
      const byId = new Map(updated.words.map(word => [word.id, word.state]));
      for (const word of words) {
        const state = byId.get(word.id);
        if (state) this.writeWord(userId, { ...word, state }, date);
      }
      return this.getSnapshot(userId, date);
    }).immediate();
  }

  putWord(userId: string, word: LearningWord, now = new Date().toISOString()): void {
    requireId(word.id, 'word.id');
    this.getGoals(userId);
    this.writeWord(userId, word, now);
  }

  getWord(userId: string, wordId: string): LearningWord | undefined {
    const row = this.db.prepare('SELECT word_json FROM learning_words WHERE user_id = ? AND word_id = ?').get(userId, wordId) as { word_json: string } | undefined;
    return row ? parse<LearningWord>(row.word_json) : undefined;
  }

  listWords(userId: string): LearningWord[] {
    return (this.db.prepare('SELECT word_json FROM learning_words WHERE user_id = ? ORDER BY word_id').all(userId) as Array<{ word_json: string }>).map(row => parse<LearningWord>(row.word_json));
  }

  /** Persist a frozen task payload once; retries return the first issued snapshot. */
  issueTask(task: LearningTask, now = new Date().toISOString()): LearningTask {
    requireId(task.taskId, 'taskId');
    this.db.prepare('INSERT OR IGNORE INTO learning_tasks (task_id,user_id,word_id,task_date,task_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(task.taskId, task.userId, task.wordId, task.date, json(task), now);
    const row = this.db.prepare('SELECT task_json FROM learning_tasks WHERE task_id = ?').get(task.taskId) as { task_json: string } | undefined;
    if (!row) throw new Error(`Could not persist task: ${task.taskId}`);
    return parse<LearningTask>(row.task_json);
  }

  getTask(taskId: string): LearningTask | undefined {
    const row = this.db.prepare('SELECT task_json FROM learning_tasks WHERE task_id = ?').get(taskId) as { task_json: string } | undefined;
    return row ? parse<LearningTask>(row.task_json) : undefined;
  }

  /** Invalid or duplicate submissions never mutate the authoritative word state or daily capacity. */
  settleFluency(input: FluencySettlement): { status: 'settled' | 'invalid' | 'duplicate'; word?: LearningWord; scoreEvent?: ScoreEvent; scheduleEvent?: ScheduleEvent } {
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT attempt_json FROM learning_attempts WHERE attempt_id = ?').get(input.attemptId) as { attempt_json: string } | undefined;
      if (prior) {
        const saved = parse<{ word?: LearningWord; scoreEvent?: ScoreEvent; scheduleEvent?: ScheduleEvent }>(prior.attempt_json);
        return { status: 'duplicate' as const, ...(saved.word ? { word: saved.word } : {}), ...(saved.scoreEvent ? { scoreEvent: saved.scoreEvent } : {}), ...(saved.scheduleEvent ? { scheduleEvent: saved.scheduleEvent } : {}) };
      }
      const task = this.getTask(input.taskId);
      if (!task || task.userId !== input.userId || task.wordId !== input.wordId || task.date !== input.date || task.type !== 'FLUENCY' || task.axis !== input.result.axis) {
        throw new Error('Attempt does not match an issued FLUENCY task');
      }
      const current = this.getWord(input.userId, input.wordId);
      if (!current) throw new Error(`Learning word not found: ${input.wordId}`);
      let scoreEvent: ScoreEvent | undefined;
      const result = schedule({ word: current.state, date: input.date, result: input.result, scoreLogger: event => { scoreEvent = { ...event, attemptId: input.attemptId }; }, logger: () => undefined });
      const valid = input.result.timingValid && input.result.materialValid !== false && !input.result.interrupted && Number.isFinite(input.result.speedWpm) && input.result.speedWpm > 0;
      const next = { ...current, state: result.word };
      const event: ScheduleEvent | undefined = valid ? {
        event: 'schedule.updated', axis: input.result.axis,
        reason: current.state[input.result.axis].learningComplete ? 'review_settlement' : 'learning_settlement',
        outcome: input.result.targetPassed && input.result.overallPassed && result.word[input.result.axis].score >= current.state[input.result.axis].target ? 'pass' : 'fail',
        date: input.date, before: { ...current.state[input.result.axis] }, after: { ...result.word[input.result.axis] }, attemptId: input.attemptId,
      } : undefined;
      if (valid) {
        this.writeWord(input.userId, next, new Date().toISOString());
        this.db.prepare(`INSERT INTO learning_daily_counts (user_id,task_date,completed) VALUES (?,?,1)
          ON CONFLICT(user_id,task_date) DO UPDATE SET completed = completed + 1`).run(input.userId, input.date);
      }
      const stored = { status: valid ? 'settled' : 'invalid', ...(valid ? { word: next, scoreEvent, scheduleEvent: event } : {}) };
      this.db.prepare('INSERT INTO learning_attempts (attempt_id,task_id,user_id,word_id,task_date,status,attempt_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(input.attemptId, input.taskId, input.userId, input.wordId, input.date, stored.status, json({ ...stored, submission: input.submission, grade: input.grade, result: input.result }), new Date().toISOString());
      return stored as { status: 'settled' | 'invalid'; word?: LearningWord; scoreEvent?: ScoreEvent; scheduleEvent?: ScheduleEvent };
    }).immediate();
  }

  getSnapshot(userId: string, date: string): LearningSnapshot {
    const goals = this.getGoals(userId);
    const row = this.db.prepare('SELECT completed FROM learning_daily_counts WHERE user_id = ? AND task_date = ?').get(userId, date) as { completed: number } | undefined;
    return { userId, goals, words: this.listWords(userId), completedToday: row?.completed ?? 0 };
  }

  private writeWord(userId: string, word: LearningWord, now: string): void {
    this.db.prepare(`INSERT INTO learning_words (user_id,word_id,word_json,version,updated_at) VALUES (?,?,?,1,?)
      ON CONFLICT(user_id,word_id) DO UPDATE SET word_json=excluded.word_json,version=learning_words.version+1,updated_at=excluded.updated_at`)
      .run(userId, word.id, json(word), now);
  }

  close(): void { this.db.close(); }
}

function requireId(value: string, name: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new RangeError(`${name} is required`);
}
function json(value: unknown): string { return JSON.stringify(value); }
function parse<T>(value: string): T { return JSON.parse(value) as T; }
