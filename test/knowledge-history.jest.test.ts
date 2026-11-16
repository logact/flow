import { buildKnowledgePointLearningHistory } from '../lib/application/knowledge-history';
import type { LearningTask } from '../lib/domain/model';

function task(id: string, knowledgePointId: string, status: 'issued' | 'completed'): LearningTask {
  const base = {
    id,
    learnerId: 'learner',
    goalId: 'goal',
    issuedAt: '2026-11-16T00:00:00.000Z',
    content: {
      schemaVersion: '1' as const,
      task: 'ENCODE' as const,
      wordId: knowledgePointId,
      content: { word: 'word', definition: 'a meaning', examples: [], instruction: 'learn it' },
    },
  };
  return status === 'completed'
    ? { ...base, status, completedAt: '2026-11-16T00:01:00.000Z' }
    : { ...base, status, completedAt: null };
}

describe('knowledge point learning history', () => {
  test('shows completed tasks without settlement and omits unrelated or unfinished tasks', () => {
    const result = buildKnowledgePointLearningHistory([
      task('completed', 'kp-1', 'completed'),
      task('unfinished', 'kp-1', 'issued'),
      task('other', 'kp-2', 'completed'),
    ], [], 'kp-1');

    expect(result.history).toEqual([{
      id: 'completed',
      date: '2026-11-16T00:01:00.000Z',
      status: 'completed',
      taskType: 'ENCODE',
      hasSettlement: false,
      judgement: null,
    }]);
    expect(result.timeline).toEqual([]);
  });
});
