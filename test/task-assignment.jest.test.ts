import { expect, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { logger as appLogger } from '../lib/logger';
import { recordNextTaskDecision, selectNextTask, type AssignmentAxis, type TaskAssignmentInput } from '../lib/task-assignment';

const axis = (overrides: Partial<AssignmentAxis> = {}): AssignmentAxis => ({ score: 40, target: 80, learningComplete: false, fluencyPass: false, reviewLevel: 1, graduated: false, dueAt: '2026-11-09', materialAvailable: true, ...overrides });
const base = (overrides: Partial<TaskAssignmentInput> = {}): TaskAssignmentInput => ({
  asOf: '2026-11-09', words: [], newWords: [], cooldownUntil: null, completedToday: 0, maxTasksToday: 10,
  capacity: { admittedWordIds: [], blockedWordId: null, blockingDate: null, reason: null }, ...overrides,
});
const newWord = (id: string, overrides: Partial<TaskAssignmentInput['newWords'][number]> = {}) => ({
  id, band: 'unknown' as const, targets: { R: 80, P: 80 }, rank: 100, rankSource: { id: 'freq', basis: 'lemma' }, materialAvailable: { R: true, P: true }, ...overrides,
});

test('复习排在学习前：到期复习和到期学习都可做时先派复习', () => {
  const result = recordNextTaskDecision(base({ words: [
    { id: 'learn', R: axis(), P: axis({ graduated: true, dueAt: 'infinity' }) },
    { id: 'review', R: axis({ learningComplete: true }), P: axis({ graduated: true, dueAt: 'infinity' }) },
  ] }));
  expect(result.task).toMatchObject({ wordId: 'review', kind: 'review', task: 'FLUENCY' });
  expect(result.candidates.find(c => c.wordId === 'learn')?.priority).toContain('2_learning');
});

test('同类别按最早 dueAt，其次词 ID 和 R/P 稳定排序', () => {
  const words = [
    { id: 'z', R: axis({ dueAt: '2026-11-08' }), P: axis({ graduated: true, dueAt: 'infinity' }) },
    { id: 'b', R: axis(), P: axis({ graduated: true, dueAt: 'infinity' }) },
    { id: 'a', R: axis(), P: axis() },
  ];
  expect(recordNextTaskDecision(base({ words })).task).toMatchObject({ wordId: 'z' });
  expect(recordNextTaskDecision(base({ words: [...words].reverse() })).task).toMatchObject({ wordId: 'z' });
  const tied = recordNextTaskDecision(base({ words: [{ id: 'a', R: axis(), P: axis() }] }));
  expect(tied.task).toMatchObject({ axis: 'R' });
  expect(tied.candidates).toHaveLength(2);
});

test('已毕业、infinity 和未来 dueAt 不派题；逾期 dueAt 保持原样', () => {
  const late = axis({ dueAt: '2026-11-08' });
  const result = recordNextTaskDecision(base({ words: [
    { id: 'skip', R: axis({ graduated: true }), P: axis({ dueAt: 'infinity' }) },
    { id: 'future', R: axis({ dueAt: '2026-11-10' }), P: axis({ graduated: true, dueAt: 'infinity' }) },
    { id: 'late', R: late, P: axis({ graduated: true, dueAt: 'infinity' }) },
  ] }));
  expect(result.task?.wordId).toBe('late');
  expect(late.dueAt).toBe('2026-11-08');
});

test('共享 ENCODE 只出现一次；其中一个轴材料缺失时不派部分 ENCODE', () => {
  const result = recordNextTaskDecision(base({ words: [{ id: 'zero', R: axis({ score: 0 }), P: axis({ score: 0 }) }] }));
  expect(result.candidates).toHaveLength(1);
  expect(result.task).toMatchObject({ axis: 'both', task: 'ENCODE' });
  const blocked = recordNextTaskDecision(base({ words: [{ id: 'zero', R: axis({ score: 0 }), P: axis({ score: 0, materialAvailable: false }) }] }));
  expect(blocked).toMatchObject({ status: 'material_unavailable', task: null });
});

test('regression: shared ENCODE is not assigned before the word is due', () => {
  const result = selectNextTask(base({
    words: [{ id: 'future-zero', R: axis({ score: 0, dueAt: '2026-11-12' }), P: axis({ score: 0, dueAt: '2026-11-12' }) }],
  }));
  expect(result.status).toBe('no_due_tasks');
  expect(result.task).toBeNull();
});

test('共享冷却会阻止所有任务；单个候选缺材料时会跳过并继续派其他任务', () => {
  const words = [
    { id: 'cooling-review', R: axis({ learningComplete: true }), P: axis({ graduated: true, dueAt: 'infinity' }) },
    { id: 'no-material', R: axis({ materialAvailable: false }), P: axis({ graduated: true, dueAt: 'infinity' }) },
    { id: 'ready', R: axis(), P: axis({ graduated: true, dueAt: 'infinity' }) },
  ];
  const cooling = recordNextTaskDecision(base({ words, cooldownUntil: '2026-11-10' }));
  expect(cooling).toMatchObject({ status: 'cooldown', task: null });
  expect(cooling.candidates.find(c => c.wordId === 'cooling-review')?.skippedReason).toBe('cooldown');
  const result = recordNextTaskDecision(base({ words: words.filter(word => word.id !== 'cooling-review') }));
  expect(result.task?.wordId).toBe('ready');
  expect(result.candidates.find(c => c.wordId === 'no-material')?.skippedReason).toBe('material_unavailable');
});

test('有可派旧任务时不插新词；旧任务没有时才选 P4 已准入的新词', () => {
  const candidate = newWord('new');
  const oldTask = { id: 'old', R: axis(), P: axis({ graduated: true, dueAt: 'infinity' }) };
  expect(recordNextTaskDecision(base({ words: [oldTask], newWords: [candidate], capacity: { admittedWordIds: ['new'], blockedWordId: null, blockingDate: null, reason: null } })).task?.wordId).toBe('old');
  expect(recordNextTaskDecision(base({ newWords: [candidate], capacity: { admittedWordIds: ['new'], blockedWordId: null, blockingDate: null, reason: null } })).task).toMatchObject({ wordId: 'new', axis: 'both', task: 'ENCODE', kind: 'new_word' });
});

test('新词先按兼容 rank 来源分组和 rank，再按目标缺口、ID 稳定排序', () => {
  const words = [
    newWord('z', { rank: 50 }),
    newWord('a', { rank: 50, targets: { R: 90, P: 90 } }),
    newWord('other-source', { rank: 1, rankSource: { id: 'other', basis: 'lemma' } }),
  ];
  const input = base({ newWords: words, capacity: { admittedWordIds: words.map(w => w.id), blockedWordId: null, blockingDate: null, reason: null } });
  expect(recordNextTaskDecision(input).task?.wordId).toBe('a');
  expect(recordNextTaskDecision({ ...input, newWords: [...words].reverse() })).toEqual(recordNextTaskDecision(input));
});

test('P4 未来阻塞日期原样展示；容量不够时不能派未准入新词', () => {
  const blocked = newWord('blocked');
  const result = recordNextTaskDecision(base({ newWords: [blocked], capacity: { admittedWordIds: [], blockedWordId: 'blocked', blockingDate: '2026-11-12', reason: 'capacity_reached' } }));
  expect(result).toMatchObject({ status: 'capacity_reached', task: null, reason: expect.stringContaining('2026-11-12') });
  expect(result.candidates[0]).toMatchObject({ eligible: false, skippedReason: 'capacity' });
});

test('没有任务时区分空队列、冷却、材料和今日容量已满', () => {
  expect(recordNextTaskDecision(base()).status).toBe('no_due_tasks');
  const candidate = newWord('x');
  const admitted = { admittedWordIds: ['x'], blockedWordId: null, blockingDate: null, reason: null };
  expect(recordNextTaskDecision(base({ newWords: [candidate], capacity: admitted, cooldownUntil: '2026-11-10' })).status).toBe('cooldown');
  expect(recordNextTaskDecision(base({ newWords: [newWord('x', { materialAvailable: { R: false, P: false } })], capacity: admitted })).status).toBe('material_unavailable');
  expect(recordNextTaskDecision(base({ newWords: [candidate], capacity: admitted, completedToday: 10 })).status).toBe('capacity_reached');
});

test('选择是纯函数，日志边界记录完整候选和选择原因', () => {
  const input = base({ words: [{ id: 'a', R: axis(), P: axis({ graduated: true, dueAt: 'infinity' }) }] });
  const copy = structuredClone(input);
  expect(selectNextTask(input)).toEqual(selectNextTask(input));
  recordNextTaskDecision(input);
  expect(input).toEqual(copy);
  const events: unknown[] = [];
  recordNextTaskDecision(input);
  const result = recordNextTaskDecision(input, event => events.push(event));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event: 'task_assignment.decided', decision: { status: 'task_selected', task: { wordId: 'a', reason: expect.any(String) }, candidates: expect.any(Array) } });
  expect(result.task?.reason).toContain('Due existing work');
});

test('持久化派题日志包含选择结果和候选说明', async () => {
  const marker = `p5-persist-${Date.now()}`;
  recordNextTaskDecision(base({ words: [{ id: marker, R: axis(), P: axis({ graduated: true, dueAt: 'infinity' }) }] }));
  await new Promise<void>((resolve, reject) => appLogger.flush(error => error ? reject(error) : resolve()));
  const file = process.env.LOG_FILE ?? path.join(process.cwd(), 'logs', 'app.log');
  let line: string | undefined;
  for (let i = 0; i < 20 && !line; i++) {
    if (existsSync(file)) {
      line = readFileSync(file, 'utf8').split('\n').find(item => item.includes(marker) && item.includes('task_assignment.decided'));
    }
    if (!line) await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(line).toBeDefined();
  expect(JSON.parse(line!)).toMatchObject({ event: 'task_assignment.decided', decision: { task: { wordId: marker }, candidates: expect.arrayContaining([expect.objectContaining({ wordId: marker, eligible: true })]) } });
});
