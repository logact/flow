import { relations, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { GoalSet } from '../goals';
import type { MaterialAnalysis, MaterialWordAnalysis } from '../material-analysis';
import type { AxisSchedule, ScheduleEvent } from '../schedule';
import type { ScoreEvent } from '../scoring';
import type { GradeDecision, GradingSubmission, AttemptValidity } from '../task-grading';
import type { GeneratedTask, LearnerTask } from '../task-material';
import type { TaskCandidate } from '../task-assignment';
import type { VocabularyEstimate } from '../vocabulary';

/**
 * Initial durable model for the learning loop.
 * JSON columns preserve versioned domain snapshots; query-critical state is
 * stored in typed columns so due-task selection and idempotency stay efficient.
 */
export const learners = sqliteTable('learners', {
  /** Stable application/auth identity for this learner. */
  id: text('id').primaryKey(),
  /** Current independent recognition (R) and production (P) score goals. */
  goals: text('goals_json', { mode: 'json' }).$type<GoalSet>().notNull(),
  /** Latest vocabulary-capacity estimate used to personalize task content. */
  vocabularyEstimate: text('vocabulary_estimate_json', { mode: 'json' }).$type<VocabularyEstimate>(),
  /** ID of the vocabularyTests record that produced vocabularyEstimate. */
  vocabularyTestId: text('vocabulary_test_id'),
  /** Learner's preferred language for task instructions and generated content. */
  language: text('language').notNull().default('en'),
  /** Optional free-text generation difficulty hint (e.g. "B1" or "middle school"); not validated or used for scoring. */
  contentLevel: text('content_level'),
  /** Maximum tasks that may be completed on one local calendar day. */
  maxTasksPerDay: integer('max_tasks_per_day').notNull().default(10),
  /** Creation timestamp in ISO 8601 format. */
  createdAt: text('created_at').notNull(),
  /** Most recent profile update timestamp in ISO 8601 format. */
  updatedAt: text('updated_at').notNull(),
}, table => [
  check('learners_max_tasks_nonnegative', sql`${table.maxTasksPerDay} >= 0`),
]);

/** Immutable evidence and estimate produced by one vocabulary-capacity test. */
export const vocabularyTests = sqliteTable('vocabulary_tests', {
  /** Unique identifier for this completed capacity test. */
  id: text('id').primaryKey(),
  /** Learner who took this test. */
  learnerId: text('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  /** Stable ID of the vocabulary list used by the test. */
  listSourceId: text('list_source_id').notNull(),
  /** Statistical/organizational basis of the vocabulary list. */
  listSourceBasis: text('list_source_basis').notNull(),
  /** Pinned data/list version; null for legacy estimators without version metadata. */
  sourceVersion: text('source_version'),
  /** Test form, sampled strata/items, and submitted answers used as estimation evidence. */
  input: text('input_json', { mode: 'json' }).$type<unknown>().notNull(),
  /** Resulting vocabulary size and optional distribution/uncertainty bounds. */
  estimate: text('estimate_json', { mode: 'json' }).$type<VocabularyEstimate>().notNull(),
  /** When the learner submitted the test, in ISO 8601 format. */
  submittedAt: text('submitted_at').notNull(),
}, table => [index('vocabulary_tests_learner_submitted').on(table.learnerId, table.submittedAt)]);

/** Original uploaded/imported content. Binary files can live outside SQLite by storageKey. */
export const materials = sqliteTable('materials', {
  /** Unique identifier for this imported material. */
  id: text('id').primaryKey(),
  /** Learner who imported the material. */
  learnerId: text('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  /** User-facing title or display name. */
  name: text('name').notNull(),
  /** Original uploaded filename, when available. */
  filename: text('filename').notNull(),
  /** Original MIME type, when available. */
  mimeType: text('mime_type'),
  /** Detected/declared source format supported by the extractor. */
  format: text('format', { enum: ['text', 'markdown', 'pdf'] }).notNull(),
  /** Content checksum used to identify duplicate imports for one learner. */
  checksum: text('checksum').notNull(),
  /** Extracted plain text used for analysis; may be omitted if content is stored externally. */
  extractedText: text('extracted_text'),
  /** Optional key/path for the original binary in external file storage. */
  storageKey: text('storage_key'),
  /** Extraction details such as OCR use, page count, or extractor version. */
  extractionMetadata: text('extraction_metadata_json', { mode: 'json' }).$type<Record<string, unknown>>(),
  /** Import timestamp in ISO 8601 format. */
  createdAt: text('created_at').notNull(),
}, table => [
  uniqueIndex('materials_learner_checksum').on(table.learnerId, table.checksum),
  index('materials_learner_created').on(table.learnerId, table.createdAt),
]);

/** A versioned analysis snapshot; re-analysis creates another row instead of rewriting history. */
export const materialAnalyses = sqliteTable('material_analyses', {
  /** Unique identifier for this one analysis run/snapshot. */
  id: text('id').primaryKey(),
  /** Learner who owns the analyzed material. */
  learnerId: text('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  /** Imported source material analyzed in this run. */
  materialId: text('material_id').notNull().references(() => materials.id, { onDelete: 'cascade' }),
  /** Shape version of the persisted analysis result. */
  schemaVersion: text('schema_version').notNull(),
  /** Name of the concrete frequency-index implementation; comes from analyzeMaterialText's `name` option. */
  indexName: text('index_name').notNull(),
  /** Version of that concrete index; comes from `version` and currently defaults to "unversioned". */
  indexVersion: text('index_version').notNull(),
  /** Identity of the vocabulary list behind the index, copied from index.source.id. */
  vocabularySourceId: text('vocabulary_source_id').notNull(),
  /** Basis used by that vocabulary list, copied from index.source.basis (e.g. word-family-frequency-band). */
  vocabularySourceBasis: text('vocabulary_source_basis').notNull(),
  /** Whether analysis completed or some words could not be assigned a vocabulary band. */
  status: text('status', { enum: ['analyzed', 'band_unavailable'] }).notNull(),
  /** Number of normalized word tokens in the extracted material. */
  tokenCount: integer('token_count').notNull(),
  /** Number of distinct matched analysis words/families. */
  uniqueWordCount: integer('unique_word_count').notNull(),
  /** Tokens not assigned to a usable vocabulary family/index entry, with reason and count. */
  unmatchedWords: text('unmatched_words_json', { mode: 'json' }).$type<MaterialAnalysis['unmatchedWords']>().notNull(),
  /** Analysis creation timestamp; a re-analysis gets its own timestamp and row. */
  createdAt: text('created_at').notNull(),
}, table => [
  index('material_analyses_material_created').on(table.materialId, table.createdAt),
  index('material_analyses_learner_created').on(table.learnerId, table.createdAt),
]);

/** Queryable word rows belonging to one analysis, with its initial score estimate preserved. */
export const materialAnalysisWords = sqliteTable('material_analysis_words', {
  /** Analysis snapshot containing this word; together with rank forms the primary key. */
  analysisId: text('analysis_id').notNull().references(() => materialAnalyses.id, { onDelete: 'cascade' }),
  /** Position of this word/family when ranked by frequency in the material. */
  rank: integer('rank').notNull(),
  /** Matched vocabulary-family ID, if the index groups words into families. */
  familyId: text('family_id'),
  /** Canonical family headword, when one was resolved. */
  headword: text('headword'),
  /** Representative word form observed in the material. */
  word: text('word').notNull(),
  /** Number of occurrences of this word/family in the material. */
  materialFrequency: integer('material_frequency').notNull(),
  /** Reference-list frequency band (for example 3k), if available. */
  vocabularyBand: text('vocabulary_band'),
  /** Initial R/P estimate and matching/comparability rationale for this word. */
  estimate: text('estimate_json', { mode: 'json' }).$type<MaterialWordAnalysis['estimate']>().notNull(),
}, table => [
  primaryKey({ columns: [table.analysisId, table.rank] }),
  index('material_analysis_words_family').on(table.familyId),
]);

/** Current mutable learning state. R/P are columns because due-date scans and settlement update them often. */
export const learningWords = sqliteTable('learning_words', {
  /** Learner who owns this vocabulary item; part of the primary key. */
  learnerId: text('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  /** Stable domain ID for this learner-word record; part of the primary key. */
  id: text('word_id').notNull(),
  /** Deduplication key, usually family ID or normalized lemma. */
  canonicalKey: text('canonical_key').notNull(),
  /** Sense identifier; distinct meanings of one spelling may be learned separately. */
  senseId: text('sense_id').notNull(),
  /** Display/headword spelling shown to the learner. */
  text: text('text').notNull(),
  /** Definition for the selected sense. */
  definition: text('definition').notNull(),
  /** Part of speech for the selected sense, if known. */
  partOfSpeech: text('part_of_speech'),
  /** Initial vocabulary-frequency band or estimate category. */
  band: text('band').notNull(),
  /** Rank in the source vocabulary list, when available. */
  rank: integer('rank'),
  /** Identity and statistical basis of the list that supplied rank. */
  rankSource: text('rank_source_json', { mode: 'json' }).$type<{ id: string; basis: string }>(),
  /** Analysis snapshot from which this word was selected, if imported from material. */
  sourceAnalysisId: text('source_analysis_id').references(() => materialAnalyses.id, { onDelete: 'set null' }),
  /** Additional source/import metadata not needed for indexed queries. */
  metadata: text('metadata_json', { mode: 'json' }).$type<Record<string, unknown>>(),
  /** R-axis current score. */
  rScore: integer('r_score').notNull(),
  /** Learner's current R-axis graduation target. */
  rTarget: integer('r_target').notNull(),
  /** Whether R-axis initial learning has been completed. */
  rLearningComplete: integer('r_learning_complete', { mode: 'boolean' }).notNull().default(false),
  /** Whether a valid R-axis fluency pass has been recorded. */
  rFluencyPass: integer('r_fluency_pass', { mode: 'boolean' }).notNull().default(false),
  /** Current R review interval in days: 1, 3, 7, or 30. */
  rReviewLevel: integer('r_review_level').$type<AxisSchedule['reviewLevel']>().notNull().default(1),
  /** Whether the R axis has completed all required review levels and graduated. */
  rGraduated: integer('r_graduated', { mode: 'boolean' }).notNull().default(false),
  /** Next R task due date as YYYY-MM-DD, or "infinity" after graduation. */
  rDueAt: text('r_due_at').notNull(),
  /** P-axis current score. */
  pScore: integer('p_score').notNull(),
  /** Learner's current P-axis graduation target. */
  pTarget: integer('p_target').notNull(),
  /** Whether P-axis initial learning has been completed. */
  pLearningComplete: integer('p_learning_complete', { mode: 'boolean' }).notNull().default(false),
  /** Whether a valid P-axis fluency pass has been recorded. */
  pFluencyPass: integer('p_fluency_pass', { mode: 'boolean' }).notNull().default(false),
  /** Current P review interval in days: 1, 3, 7, or 30. */
  pReviewLevel: integer('p_review_level').$type<AxisSchedule['reviewLevel']>().notNull().default(1),
  /** Whether the P axis has completed all required review levels and graduated. */
  pGraduated: integer('p_graduated', { mode: 'boolean' }).notNull().default(false),
  /** Next P task due date as YYYY-MM-DD, or "infinity" after graduation. */
  pDueAt: text('p_due_at').notNull(),
  /** When this word entered the learner's active vocabulary. */
  createdAt: text('created_at').notNull(),
  /** When any current word or R/P schedule state was last changed. */
  updatedAt: text('updated_at').notNull(),
  /** Optimistic concurrency/version counter, incremented on each state update. */
  version: integer('version').notNull().default(1),
}, table => [
  primaryKey({ columns: [table.learnerId, table.id] }),
  uniqueIndex('learning_words_learner_canonical_sense').on(table.learnerId, table.canonicalKey, table.senseId),
  index('learning_words_learner_r_due').on(table.learnerId, table.rGraduated, table.rDueAt),
  index('learning_words_learner_p_due').on(table.learnerId, table.pGraduated, table.pDueAt),
  check('learning_words_review_level_valid', sql`${table.rReviewLevel} IN (1, 3, 7, 30) AND ${table.pReviewLevel} IN (1, 3, 7, 30)`),
]);

/** Provider generation diagnostics are optional; only a ready task is issued to a learner. */
export const taskGenerationRuns = sqliteTable('task_generation_runs', {
  /** Unique identifier for a task-material generation operation. */
  id: text('id').primaryKey(),
  /** Learner for whom the task material was generated. */
  learnerId: text('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  /** Target learner-word ID. */
  wordId: text('word_id').notNull(),
  /** Whether usable task content was generated. */
  status: text('status', { enum: ['ready', 'unavailable'] }).notNull(),
  /** Provider that produced the result, if a provider call occurred. */
  provider: text('provider'),
  /** Model name used by the provider, when available. */
  model: text('model'),
  /** Prompt/schema version used for generation. */
  promptVersion: text('prompt_version').notNull(),
  /** Validation/provider errors encountered during generation. */
  errors: text('errors_json', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /** Optional request/response diagnostics; redact credentials before storing. */
  diagnostics: text('diagnostics_json', { mode: 'json' }).$type<Record<string, unknown>>(),
  /** Generation start/completion timestamp. */
  createdAt: text('created_at').notNull(),
}, table => [
  foreignKey({ columns: [table.learnerId, table.wordId], foreignColumns: [learningWords.learnerId, learningWords.id], onDelete: 'restrict' }),
  index('task_generation_runs_learner_created').on(table.learnerId, table.createdAt),
]);

/** Frozen task returned by the API, including server-only answers/rubric and learner-safe content. */
export const issuedTasks = sqliteTable('issued_tasks', {
  /** Stable task ID returned to the learner/client. */
  id: text('id').primaryKey(),
  /** Learner receiving this task. */
  learnerId: text('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  /** Target word ID. */
  wordId: text('word_id').notNull(),
  /** Client/service idempotency key; retrying it returns this same issued task. */
  requestKey: text('request_key').notNull(),
  /** Local date on which this task was issued. */
  date: text('task_date').notNull(),
  /** Target axis, or both axes for a shared ENCODE task. */
  axis: text('axis', { enum: ['R', 'P', 'both'] }).notNull(),
  /** Task behavior: encode, retrieve, or fluency. */
  taskType: text('task_type', { enum: ['ENCODE', 'RETRIEVE', 'FLUENCY'] }).notNull(),
  /** Why this word was selected: review, ongoing learning, or newly admitted. */
  candidateKind: text('candidate_kind', { enum: ['review', 'learning', 'new_word'] }).notNull(),
  /** Retrieval progression level; null for non-RETRIEVE tasks. */
  retrieveStage: text('retrieve_stage', { enum: ['choice', 'cued', 'free'] }),
  /** Frozen task-selection decision and candidate context for audit/retry. */
  candidateSnapshot: text('candidate_snapshot_json', { mode: 'json' }).$type<TaskCandidate>().notNull(),
  /** Full server-side task, including answer keys/rubric; never return directly to the learner. */
  generatedMaterial: text('generated_material_json', { mode: 'json' }).$type<GeneratedTask>().notNull(),
  /** Redacted learner-facing task payload safe to return from the API. */
  learnerMaterial: text('learner_material_json', { mode: 'json' }).$type<LearnerTask>().notNull(),
  /** Generation run that produced the content, when applicable. */
  generationRunId: text('generation_run_id').references(() => taskGenerationRuns.id, { onDelete: 'set null' }),
  /** Task issuance timestamp. */
  createdAt: text('created_at').notNull(),
}, table => [
  foreignKey({ columns: [table.learnerId, table.wordId], foreignColumns: [learningWords.learnerId, learningWords.id], onDelete: 'restrict' }),
  uniqueIndex('issued_tasks_request_key').on(table.learnerId, table.requestKey),
  index('issued_tasks_learner_date').on(table.learnerId, table.date),
]);

/** First answer per issued task; state transitions and settlement happen under one DB transaction. */
export const taskAttempts = sqliteTable('task_attempts', {
  /** Stable attempt/idempotency identifier supplied by the client or service. */
  id: text('id').primaryKey(),
  /** Issued task being answered; unique so one task accepts its first attempt only. */
  taskId: text('task_id').notNull().unique().references(() => issuedTasks.id, { onDelete: 'restrict' }),
  /** Learner submitting the answer. */
  learnerId: text('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  /** Word targeted by the issued task. */
  wordId: text('word_id').notNull(),
  /** Local date used for due-date and daily-completion accounting. */
  date: text('attempt_date').notNull(),
  /** Lifecycle state from receipt through grading to final settlement. */
  status: text('status', { enum: ['received', 'grading', 'unavailable', 'invalid', 'settled'] }).notNull(),
  /** Frozen first answer; retries must continue using this exact submission. */
  submission: text('submission_json', { mode: 'json' }).$type<GradingSubmission | unknown>().notNull(),
  /** Timing/interruption/material checks used to decide whether the attempt is valid. */
  validity: text('validity_json', { mode: 'json' }).$type<AttemptValidity>(),
  /** Objective/AI grading decision, or unavailable/invalid result. */
  grade: text('grade_json', { mode: 'json' }).$type<GradeDecision>(),
  /** Score event produced when settlement changes or evaluates the score. */
  scoreEvent: text('score_event_json', { mode: 'json' }).$type<ScoreEvent>(),
  /** Schedule event produced when settlement evaluates the review schedule. */
  scheduleEvent: text('schedule_event_json', { mode: 'json' }).$type<ScheduleEvent>(),
  /** R/P state snapshot after successful settlement, for an audit response. */
  settledWordSnapshot: text('settled_word_snapshot_json', { mode: 'json' }).$type<{ R: AxisSchedule; P: AxisSchedule }>(),
  /** When the first submission was accepted by the system. */
  receivedAt: text('received_at').notNull(),
  /** When authoritative word-state settlement completed; null before settlement. */
  settledAt: text('settled_at'),
}, table => [
  foreignKey({ columns: [table.learnerId, table.wordId], foreignColumns: [learningWords.learnerId, learningWords.id], onDelete: 'restrict' }),
  index('task_attempts_learner_date_status').on(table.learnerId, table.date, table.status),
]);

/** Each external grader retry is retained separately so a retry never replaces the first answer. */
export const gradingProviderAttempts = sqliteTable('grading_provider_attempts', {
  /** Unique identifier for this individual external grader call. */
  id: text('id').primaryKey(),
  /** Frozen learner attempt this provider call belongs to. */
  attemptId: text('attempt_id').notNull().references(() => taskAttempts.id, { onDelete: 'cascade' }),
  /** One-based retry order for this attempt. */
  ordinal: integer('ordinal').notNull(),
  /** Grading provider name. */
  provider: text('provider').notNull(),
  /** Model name used for this grading call. */
  model: text('model').notNull(),
  /** Grading prompt/rubric version. */
  promptVersion: text('prompt_version').notNull(),
  /** Whether provider output passed parsing and grade-schema validation. */
  valid: integer('valid', { mode: 'boolean' }).notNull(),
  /** Parse, provider, or schema errors for this call. */
  errors: text('errors_json', { mode: 'json' }).$type<string[]>().notNull(),
  /** Normalized grade decision, when this call produced one. */
  decision: text('decision_json', { mode: 'json' }).$type<GradeDecision>(),
  /** Optional request/response diagnostics; redact credentials and sensitive headers. */
  diagnostics: text('diagnostics_json', { mode: 'json' }).$type<Record<string, unknown>>(),
  /** Provider-call timestamp. */
  createdAt: text('created_at').notNull(),
}, table => [
  uniqueIndex('grading_provider_attempts_ordinal').on(table.attemptId, table.ordinal),
]);

/** Append-only audit trail for goal changes, task decisions, scores and schedules. */
export const learningEvents = sqliteTable('learning_events', {
  /** Unique event ID for append-only audit history. */
  id: text('id').primaryKey(),
  /** Learner whose learning history this event belongs to. */
  learnerId: text('learner_id').notNull().references(() => learners.id, { onDelete: 'cascade' }),
  /** Event name, such as goal.updated or task_assignment.decided. */
  eventType: text('event_type').notNull(),
  /** Kind of entity the event concerns (word, task, learner, and so on). */
  entityType: text('entity_type').notNull(),
  /** ID of the affected entity. */
  entityId: text('entity_id').notNull(),
  /** Versioned event-specific details and before/after data. */
  payload: text('payload_json', { mode: 'json' }).$type<unknown>().notNull(),
  /** Time the domain event occurred, in ISO 8601 format. */
  occurredAt: text('occurred_at').notNull(),
}, table => [index('learning_events_learner_time').on(table.learnerId, table.occurredAt)]);

export const learnerRelations = relations(learners, ({ many }) => ({
  materials: many(materials),
  vocabularyTests: many(vocabularyTests),
  words: many(learningWords),
  tasks: many(issuedTasks),
  attempts: many(taskAttempts),
  events: many(learningEvents),
}));

export const materialRelations = relations(materials, ({ many }) => ({ analyses: many(materialAnalyses) }));
export const materialAnalysisRelations = relations(materialAnalyses, ({ one, many }) => ({
  material: one(materials, { fields: [materialAnalyses.materialId], references: [materials.id] }),
  words: many(materialAnalysisWords),
}));
export const learningWordRelations = relations(learningWords, ({ one, many }) => ({
  learner: one(learners, { fields: [learningWords.learnerId], references: [learners.id] }),
  tasks: many(issuedTasks),
  attempts: many(taskAttempts),
}));
export const issuedTaskRelations = relations(issuedTasks, ({ one }) => ({
  learner: one(learners, { fields: [issuedTasks.learnerId], references: [learners.id] }),
  word: one(learningWords, { fields: [issuedTasks.learnerId, issuedTasks.wordId], references: [learningWords.learnerId, learningWords.id] }),
  attempt: one(taskAttempts),
}));
export const taskAttemptRelations = relations(taskAttempts, ({ one, many }) => ({
  task: one(issuedTasks, { fields: [taskAttempts.taskId], references: [issuedTasks.id] }),
  gradingAttempts: many(gradingProviderAttempts),
}));
