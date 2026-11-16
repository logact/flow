import type { LearningTask, TaskAttempt } from '../domain/model';

export interface KnowledgeLearningEvent {
  id: string;
  date: string;
  status: string;
  taskType: string;
  hasSettlement: boolean;
  judgement: unknown;
}

export interface KnowledgeFluencyChange {
  date: string;
  dimension: string;
  before: number;
  after: number;
}

/** Merge completed task events with their optional settlement evidence for one knowledge point. */
export function buildKnowledgePointLearningHistory(
  tasks: LearningTask[],
  attempts: TaskAttempt[],
  knowledgePointId: string,
): { history: KnowledgeLearningEvent[]; timeline: KnowledgeFluencyChange[] } {
  const matchingTasks = tasks.filter((task) => task.content.wordId === knowledgePointId);
  const taskIds = new Set(matchingTasks.map((task) => task.id));
  const relatedAttempts = attempts.filter((attempt) => taskIds.has(attempt.taskId))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const attemptByTask = new Map(relatedAttempts.map((attempt) => [attempt.taskId, attempt]));
  const history: KnowledgeLearningEvent[] = [];
  for (const task of matchingTasks) {
    const attempt = attemptByTask.get(task.id);
    if (attempt) {
      history.push({
        id: attempt.id,
        date: attempt.receivedAt,
        status: attempt.status,
        taskType: task.content.task,
        hasSettlement: attempt.status === 'settled',
        judgement: attempt.status === 'settled' ? attempt.judgement : null,
      });
    } else if (task.status === 'completed' && task.completedAt) {
      history.push({
        id: task.id,
        date: task.completedAt,
        status: 'completed',
        taskType: task.content.task,
        hasSettlement: false,
        judgement: null,
      });
    }
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  const timeline: KnowledgeFluencyChange[] = [];
  for (const attempt of relatedAttempts) {
    if (attempt.status !== 'settled') continue;
    for (const change of attempt.settlement.fluencyChanges) {
      if (change.knowledgePointId === knowledgePointId) {
        timeline.push({ date: attempt.receivedAt, dimension: change.dimension, before: change.before, after: change.after });
      }
    }
  }
  return { history, timeline };
}
