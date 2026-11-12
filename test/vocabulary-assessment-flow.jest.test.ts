/// <reference types="jest" />

import vocabularyFixture from '../data/bnc-coca-l6-fixture.json';
import * as Domain from '../lib/domain/functions';
import type * as Model from '../lib/domain/model';

const families: Domain.VocabularyAssessmentWordFamily[] = vocabularyFixture.families.map((family) => ({
  ...family,
  band: family.band as Model.VocabularyBand,
}));

function logArtifact(label: string, artifact: unknown): void {
  console.log(`\n=== ${label} ===\n${JSON.stringify(artifact, null, 2)}`);
}

describe('S02 词汇自评定级流程产物', () => {
  test('输出从抽样到词汇估计的全部产物', () => {
    const learner = Domain.createLearner({
      id: 'learner-s02-log',
      timezone: 'Asia/Shanghai',
      dailyTaskCapacity: 3,
      now: '2026-11-12T00:00:00.000Z',
    });
    logArtifact('01 创建学习者', learner);

    const samples = Domain.sampleVocabularyForAssessment({
      list: { id: vocabularyFixture.source, version: vocabularyFixture.version },
      families,
      sampleCounts: { '1k': 1, '2k': 1 },
      seed: 's02-log-seed',
    });
    logArtifact('02 分层抽样结果', samples);

    const tasks = Domain.generateVocabularyAssessmentTasks({
      samples,
      taskIds: samples.map((_, index) => `assessment-task-${index + 1}`),
    });
    logArtifact('03 服务端词汇自评任务（无选项和答案）', tasks);

    const assessment = Domain.createVocabularyAssessment({
      id: 'assessment-s02-log',
      learnerId: learner.id,
      tasks,
      now: '2026-11-12T00:01:00.000Z',
    });
    logArtifact('04 创建进行中的测评', assessment);

    const publicTasks = tasks.map(Domain.toLearnerVocabularyAssessmentTask);
    logArtifact('05 学习者可见的自评词汇', publicTasks);

    const attempts: Model.VocabularyAssessmentAttempt[] = [];
    tasks.forEach((task, index) => {
      const attempt = Domain.recordVocabularyAssessmentAttempt({
        attemptId: `assessment-attempt-${index + 1}`,
        assessment,
        task,
        previousAttempts: [...attempts],
        known: index !== 1,
        answeredAt: `2026-11-12T00:0${index + 2}:00.000Z`,
      });
      attempts.push(attempt);
      logArtifact(`06.${index + 1} 第 ${index + 1} 个词汇的自评结果`, attempt);
    });

    const completed = Domain.completeVocabularyAssessment({
      learner,
      assessment,
      tasks,
      attempts,
      list: { id: vocabularyFixture.source, version: vocabularyFixture.version },
      bandWordFamilyCounts: { '1k': 1000, '2k': 2000 },
      now: '2026-11-12T00:10:00.000Z',
    });
    logArtifact('07 完成后的测评与词汇估计', completed.assessment);
    logArtifact('08 更新后的学习者', completed.learner);
    logArtifact('09 各词段结果摘要', completed.assessment.result.bands.map((band) => ({
      band: band.band,
      sampleCount: band.sampleCount,
      knownCount: band.knownCount,
      knownProbability: band.knownProbability,
      interval: band.interval,
    })));

    expect(samples).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.known)).toEqual([true, false]);
    expect(publicTasks).toEqual(tasks.map((task) => ({
      id: task.id,
      band: task.band,
      knowledgePointId: task.knowledgePoint.id,
      lemma: task.knowledgePoint.lemma,
    })));
    expect(completed.assessment.status).toBe('completed');
    expect(completed.assessment.result.bands.map((band) => band.knownProbability)).toEqual([1, 0]);
    expect(completed.assessment.result.bands.map((band) => band.knownCount)).toEqual([1, 0]);
    expect(completed.learner.currentVocabulary).toEqual(completed.assessment.result);
  });
});
