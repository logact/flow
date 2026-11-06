import type Database from 'better-sqlite3';

export interface TaskAnalyticsFilter {
  since?: number;
  until?: number;
}

export interface TaskAnalyticsGroup {
  definition_id: string | null;
  axis: string | null;
  checkpoint: number | null;
  purpose: string | null;
  attempts: number;
  passed: number;
  failed: number;
  practice: number;
  pass_rate: number | null;
  recheck_attempts: number;
  recheck_failures: number;
  recheck_failure_rate: number | null;
  material_missing: number;
  skipped: number;
  exits: number;
  skip_rate: number | null;
  exit_rate: number | null;
  speed_distribution: {
    count: number;
    mean: number | null;
    min: number | null;
    p50: number | null;
    p90: number | null;
    max: number | null;
  };
}

type EventRow = { kind: string; ts: number; result: string | null; detail: string | null };
type AnalyticsEventRow = {
  event_type: string;
  definition_id: string | null;
  axis: string | null;
  checkpoint: number | null;
  purpose: string | null;
  speed_value: number | null;
  detail: string | null;
};
type Dimensions = {
  definition_id: string | null;
  axis: string | null;
  checkpoint: number | null;
  purpose: string | null;
};

type MutableGroup = TaskAnalyticsGroup & { speeds: number[] };

const keyOf = (dims: Dimensions) => JSON.stringify([
  dims.definition_id,
  dims.axis,
  dims.checkpoint,
  dims.purpose,
]);

const emptyGroup = (dims: Dimensions): MutableGroup => ({
  ...dims,
  attempts: 0,
  passed: 0,
  failed: 0,
  practice: 0,
  pass_rate: null,
  recheck_attempts: 0,
  recheck_failures: 0,
  recheck_failure_rate: null,
  material_missing: 0,
  skipped: 0,
  exits: 0,
  skip_rate: null,
  exit_rate: null,
  speed_distribution: { count: 0, mean: null, min: null, p50: null, p90: null, max: null },
  speeds: [],
});

function detailOf(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function boundedRows<T extends { ts: number }>(rows: T[], filter: TaskAnalyticsFilter): T[] {
  return rows.filter((row) =>
    (filter.since == null || row.ts >= filter.since) &&
    (filter.until == null || row.ts <= filter.until)
  );
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const index = Math.max(0, Math.ceil(p * values.length) - 1);
  return values[index];
}

/**
 * Aggregate score events and privacy-safe lifecycle/material events. Raw responses
 * are never selected or returned. A missing checkpoint is kept as null, not guessed.
 */
export function getTaskAnalytics(db: Database.Database, filter: TaskAnalyticsFilter = {}) {
  const scoreEvents = boundedRows(
    db.prepare(`SELECT kind, ts, result, detail FROM events ORDER BY ts`).all() as EventRow[],
    filter
  );
  const lifecycleEvents = boundedRows(
    db.prepare(`SELECT event_type, definition_id, axis, checkpoint, purpose, speed_value, detail, ts
                  FROM task_analytics_events ORDER BY ts`).all() as (AnalyticsEventRow & { ts: number })[],
    filter
  );
  const groups = new Map<string, MutableGroup>();
  const groupFor = (dims: Dimensions) => {
    const key = keyOf(dims);
    let group = groups.get(key);
    if (!group) {
      group = emptyGroup(dims);
      groups.set(key, group);
    }
    return group;
  };

  for (const event of scoreEvents) {
    if (!event.kind.includes(':')) continue;
    const [type, purpose, axis] = event.kind.split(':');
    if (!type || !purpose || (axis !== 'p' && axis !== 'r')) continue;
    const detail = detailOf(event.detail);
    const definitionId = typeof detail.definition_id === 'string'
      ? detail.definition_id
      : `${type.toLowerCase()}-${axis}`;
    const checkpoint = typeof detail.checkpoint === 'number' && Number.isFinite(detail.checkpoint)
      ? detail.checkpoint
      : null;
    const dims = { definition_id: definitionId, axis, checkpoint, purpose };
    const group = groupFor(dims);
    if (event.result === 'pass') {
      group.attempts += 1;
      group.passed += 1;
    } else if (event.result === 'fail') {
      group.attempts += 1;
      group.failed += 1;
    } else if (event.result === 'practice') {
      group.practice += 1;
    }
    const isRecheck = detail.recheck === true || (detail.recheck == null && purpose === 'recover');
    if (isRecheck) {
      if (event.result === 'pass' || event.result === 'fail') {
        group.recheck_attempts += 1;
        if (event.result === 'fail') group.recheck_failures += 1;
      }
    }
    const speed = detail.speed_value;
    if (typeof speed === 'number' && Number.isFinite(speed) && speed > 0) group.speeds.push(speed);
  }

  for (const event of lifecycleEvents) {
    const dims = {
      definition_id: event.definition_id,
      axis: event.axis,
      checkpoint: event.checkpoint,
      purpose: event.purpose,
    };
    const group = groupFor(dims);
    if (event.event_type === 'material_missing') {
      const detail = detailOf(event.detail);
      const affected = detail.affected_candidate_count;
      group.material_missing += typeof affected === 'number' && Number.isFinite(affected)
        ? Math.max(1, affected)
        : 1;
    }
    if (event.event_type === 'task_skipped') group.skipped += 1;
    if (event.event_type === 'task_exit') group.exits += 1;
    if (typeof event.speed_value === 'number' && Number.isFinite(event.speed_value) && event.speed_value > 0) {
      group.speeds.push(event.speed_value);
    }
  }

  const result = [...groups.values()].map(({ speeds, ...group }) => {
    const sorted = [...speeds].sort((a, b) => a - b);
    const attemptsAndLifecycle = group.attempts + group.exits + group.skipped;
    return {
      ...group,
      pass_rate: group.attempts > 0 ? group.passed / group.attempts : null,
      recheck_failure_rate: group.recheck_attempts > 0 ? group.recheck_failures / group.recheck_attempts : null,
      skip_rate: attemptsAndLifecycle > 0 ? group.skipped / attemptsAndLifecycle : null,
      exit_rate: attemptsAndLifecycle > 0 ? group.exits / attemptsAndLifecycle : null,
      speed_distribution: {
        count: sorted.length,
        mean: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
        min: sorted[0] ?? null,
        p50: percentile(sorted, 0.5),
        p90: percentile(sorted, 0.9),
        max: sorted[sorted.length - 1] ?? null,
      },
    } satisfies TaskAnalyticsGroup;
  }).sort((a, b) =>
    (a.definition_id ?? '').localeCompare(b.definition_id ?? '') ||
    (a.axis ?? '').localeCompare(b.axis ?? '') ||
    (a.checkpoint ?? -1) - (b.checkpoint ?? -1) ||
    (a.purpose ?? '').localeCompare(b.purpose ?? '')
  );

  return {
    since: filter.since ?? null,
    until: filter.until ?? null,
    totals: result.reduce((totals, group) => ({
      attempts: totals.attempts + group.attempts,
      passed: totals.passed + group.passed,
      failed: totals.failed + group.failed,
      recheck_failures: totals.recheck_failures + group.recheck_failures,
      material_missing: totals.material_missing + group.material_missing,
      skip_count: totals.skip_count + group.skipped,
      exit_count: totals.exit_count + group.exits,
      speed_samples: totals.speed_samples + group.speed_distribution.count,
    }), {
      attempts: 0,
      passed: 0,
      failed: 0,
      recheck_failures: 0,
      material_missing: 0,
      skip_count: 0,
      exit_count: 0,
      speed_samples: 0,
    }),
    groups: result,
    instrumentation: {
      material_missing: true,
      exits: true,
      skips: false,
      skip_note: 'No explicit skip/defer action is currently exposed; unsubmitted swipe is ignored.',
    },
  };
}
