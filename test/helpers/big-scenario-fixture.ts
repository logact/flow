/**
 * 大场景测试共享夹具：含 10 个知识点的材料、单义词义库、
 * 可为任意规格生成合法题目的 Fake AI Provider、Fake AI Judge 与作答策略。
 * Fake 输出全部满足 validateGeneratedTask 的硬性校验；
 * 除注入失败外行为确定，主测试与失败路径测试跑同一套契约。
 */

import type { SemanticJudgementResult, TaskAIJudge } from '../../lib/application/ai-judge';
import type {
  InventorySense,
  SenseInventory,
  TaskGenerationAIProvider,
  TaskGenerationAIRequest,
} from '../../lib/application/ports';
import type { TaskSpecification } from '../../lib/domain/functions';
import type {
  AttemptValidity,
  KnowledgePoint,
  LearningTask,
  TaskSubmission,
  TextRetrieveTaskSubmission,
} from '../../lib/domain/model';

export const learnerId = 'learner-xiaolin';
export const learnerTimezone = 'Asia/Shanghai';
export const dailyTaskCapacity = 5;
export const goalId = 'goal-adapt';
export const goalTitle = '读懂并谈论团队如何应对变化';
export const targetFluency = { R: 80, P: 80 };
export const policyVersion = 'initial-v1';
export const analyzerVersion = 'analyzer-v1';

/** 含 10 个目标词的材料原文；其余词由词表过滤进入 unmatchedItems。 */
export const materialText = 'Contemporary teams work in a world where digital tools are ubiquitous. '
  + 'When a project changes, a deliberate response is more useful than a rushed one. '
  + 'A resilient team learns from the setback, adjusts its plan, and keeps moving. '
  + 'Teams that adapt quickly treat every pivot as a chance to learn. '
  + 'Honest feedback protects morale and builds momentum, because people do their best work when they feel heard.';

export interface ScenarioWord {
  lemma: string;
  pos: string;
  /** 中文释义，进入知识点义项与题目模板。 */
  definition: string;
  /** 英文 gloss，进入词义库。 */
  gloss: string;
}

export const scenarioWords: ScenarioWord[] = [
  { lemma: 'contemporary', pos: 'adjective', definition: '现代的，当代的', gloss: 'belonging to the present time' },
  { lemma: 'ubiquitous', pos: 'adjective', definition: '无处不在的', gloss: 'present everywhere' },
  { lemma: 'deliberate', pos: 'adjective', definition: '深思熟虑的', gloss: 'carefully considered' },
  { lemma: 'resilient', pos: 'adjective', definition: '有韧性的，能迅速恢复的', gloss: 'able to recover quickly from difficulties' },
  { lemma: 'adapt', pos: 'verb', definition: '适应，调整', gloss: 'to change in order to fit new conditions' },
  { lemma: 'setback', pos: 'noun', definition: '挫折，阻碍', gloss: 'a problem that delays or stops progress' },
  { lemma: 'pivot', pos: 'noun', definition: '转向，转变', gloss: 'a change of direction or strategy' },
  { lemma: 'feedback', pos: 'noun', definition: '反馈', gloss: 'comments about how well something is done' },
  { lemma: 'morale', pos: 'noun', definition: '士气', gloss: 'the confidence and enthusiasm of a group' },
  { lemma: 'momentum', pos: 'noun', definition: '势头', gloss: 'the force that keeps something developing' },
];

/** 知识点 ID 规则与 analyzeMaterial 一致：word:{lemma}:{senseId}。 */
export function senseIdFor(lemma: string): string {
  return `wn31:${lemma}:1`;
}

export function knowledgePointIdFor(lemma: string): string {
  return `word:${lemma}:${senseIdFor(lemma)}`;
}

export function knowledgePointFor(word: ScenarioWord): KnowledgePoint {
  return {
    id: knowledgePointIdFor(word.lemma),
    kind: 'word',
    lemma: word.lemma,
    wordFamily: word.lemma,
    sense: {
      id: senseIdFor(word.lemma),
      definition: word.definition,
      partOfSpeech: word.pos,
      explanation: null,
    },
  };
}

/** 取词元：大场景的知识点全部是词汇点，语法/其他点用名称兜底。 */
function lemmaOf(knowledgePoint: KnowledgePoint): string {
  return knowledgePoint.kind === 'word' || knowledgePoint.kind === 'phrase'
    ? knowledgePoint.lemma
    : knowledgePoint.name;
}

/** 单义词义库：每个目标词只有一个义项，S04 不经 AI 直接选定；gloss 取中文定义，与 plan 夹具风格一致。 */
export const fakeSenseInventory: SenseInventory = {
  lookup(lemma: string): InventorySense[] {
    const word = scenarioWords.find((item) => item.lemma === lemma);
    return word ? [{ id: senseIdFor(lemma), pos: word.pos, gloss: word.definition }] : [];
  },
};

/** S04 词表过滤：只保留场景目标词，其余词不生成知识点。 */
export function scenarioVocabularyFilter(lemma: string): true | { keep: false; reason: string } {
  return scenarioWords.some((word) => word.lemma === lemma)
    ? true
    : { keep: false, reason: 'not-a-scenario-target' };
}

// ── Fake AI Provider：模板生成合法题目 ────────────────────────────

function countOccurrences(text: string, target: string): number {
  const escaped = target.replace(/[.*+?^${}|[\]\\]/g, '\\$&');
  return (text.match(new RegExp(`\\b${escaped}\\b`, 'giu')) ?? []).length;
}

function firstSentenceOf(text: string): string {
  return (text.match(/[^.!?…\n]+[.!?…]+/)?.[0] ?? text).trim();
}

function buildEncodeTask(knowledgePoint: KnowledgePoint) {
  return {
    schemaVersion: '1' as const,
    task: 'ENCODE' as const,
    wordId: knowledgePoint.id,
    content: {
      word: lemmaOf(knowledgePoint),
      partOfSpeech: knowledgePoint.sense.partOfSpeech,
      definition: knowledgePoint.sense.definition,
      examples: [{ sentence: `A team that values ${lemmaOf(knowledgePoint)} handles change better.` }],
      instruction: 'Read the word, meaning, and example, then confirm when you are ready.',
    },
  };
}

function buildRetrieveTask(specification: TaskSpecification & { task: 'RETRIEVE' }, knowledgePoint: KnowledgePoint) {
  const base = {
    schemaVersion: '1' as const,
    task: 'RETRIEVE' as const,
    wordId: knowledgePoint.id,
  };
  if (specification.stage === 'choice') {
    return {
      ...base,
      content: {
        axis: specification.axis,
        stage: 'choice' as const,
        prompt: `What does ${lemmaOf(knowledgePoint)} mean?`,
        options: [
          { id: 'a', text: knowledgePoint.sense.definition },
          { id: 'b', text: 'an unrelated idea' },
        ],
        answerOptionId: 'a',
        explanation: `${lemmaOf(knowledgePoint)} means ${knowledgePoint.sense.definition}.`,
      },
    };
  }
  const cued = specification.stage === 'cued';
  return {
    ...base,
    content: {
      axis: specification.axis,
      stage: specification.stage,
      prompt: cued
        ? `用英文表达这个意思：${knowledgePoint.sense.definition}。（提示：首字母 ${lemmaOf(knowledgePoint)[0]}）`
        : `请用英文表达“${knowledgePoint.sense.definition}”。`,
      ...(cued ? { cue: lemmaOf(knowledgePoint)[0] } : {}),
      answerKey: {
        acceptedAnswers: [lemmaOf(knowledgePoint)],
        explanation: `${lemmaOf(knowledgePoint)} means ${knowledgePoint.sense.definition}.`,
      },
    },
  };
}

function buildFluencyTask(specification: TaskSpecification & { task: 'FLUENCY' }, knowledgePoint: KnowledgePoint) {
  if (specification.axis === 'P') {
    return {
      schemaVersion: '1' as const,
      task: 'FLUENCY' as const,
      wordId: knowledgePoint.id,
      content: {
        axis: 'P' as const,
        scenario: `请描述一个团队体现“${knowledgePoint.sense.definition}”的场景。`,
        responseInstruction: '请用英文自然地表达你的想法。',
        gradingRequirements: {
          targetExpression: lemmaOf(knowledgePoint),
          targetUseCriteria: [`自然且正确地使用 ${lemmaOf(knowledgePoint)}。`],
          overallExpressionCriteria: ['表达完整、语义清楚。'],
        },
      },
    };
  }
  const filler = `Teams that practice ${lemmaOf(knowledgePoint)} stay calm under pressure.`;
  const passage = `${materialText} ${filler} ${filler} ${filler}`;
  return {
    schemaVersion: '1' as const,
    task: 'FLUENCY' as const,
    wordId: knowledgePoint.id,
    content: {
      axis: 'R' as const,
      passage,
      questions: [
        {
          id: 'target-meaning',
          role: 'target_meaning' as const,
          kind: 'choice' as const,
          prompt: `What does ${lemmaOf(knowledgePoint)} mean?`,
          evidence: firstSentenceOf(materialText),
          options: [
            { id: 'a', text: knowledgePoint.sense.definition },
            { id: 'b', text: 'an unrelated idea' },
          ],
          answerOptionId: 'a',
        },
        {
          id: 'passage-comprehension',
          role: 'passage_comprehension' as const,
          kind: 'free' as const,
          prompt: 'Summarize the passage in one sentence.',
          evidence: 'A resilient team learns from the setback, adjusts its plan, and keeps moving.',
          answer: 'The passage says a good team stays calm, learns, and keeps moving when change comes.',
        },
      ],
      targetOccurrences: countOccurrences(passage, lemmaOf(knowledgePoint)),
    },
  };
}

export function buildGeneratedTaskFor(request: TaskGenerationAIRequest): ReturnType<JSON['parse']> {
  const { specification, knowledgePoint } = request;
  if (specification.task === 'ENCODE') return buildEncodeTask(knowledgePoint);
  if (specification.task === 'RETRIEVE') return buildRetrieveTask(specification, knowledgePoint);
  return buildFluencyTask(specification, knowledgePoint);
}

/**
 * Fake AI Provider：按规格模板生成合法题目；
 * failNext 置位后下一次调用抛错（失败注入），随后自动恢复。
 */
export class FakeTaskAIProvider implements TaskGenerationAIProvider {
  readonly requests: TaskGenerationAIRequest[] = [];
  failNext = false;

  async generateTask(request: TaskGenerationAIRequest): Promise<string> {
    this.requests.push(request);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Fake AI provider failure');
    }
    return JSON.stringify(buildGeneratedTaskFor(request));
  }
}

// ── Fake AI Judge：语义判断固定给通过 ─────────────────────────────

/**
 * Fake AI Judge：按提交内容核对答案（本场景的作答全部正确，除测试故意答错的选择题——
 * 选择题不走 AI）。failNext 置位后下一次调用抛错（失败注入）。
 */
export class FakeTaskAIJudge implements TaskAIJudge {
  readonly judged: Array<{ taskId: string }> = [];
  failNext = false;

  async judge(input: { task: LearningTask; submission: TaskSubmission }): Promise<SemanticJudgementResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Fake AI judge failure');
    }
    const { task, submission } = input;
    this.judged.push({ taskId: task.id });
    const content = task.content;
    if (content.task === 'RETRIEVE') {
      const retrieve = content.content;
      if (retrieve.stage === 'choice') {
        throw new Error('选择题由规则评判，不走 AI');
      }
      const answerKey = retrieve.answerKey;
      const answer = (submission as TextRetrieveTaskSubmission).answer ?? '';
      const accepted = answerKey.acceptedAnswers.some(
        (item) => item.trim().toLowerCase() === answer.trim().toLowerCase(),
      );
      return { taskId: task.id, retrieveAccepted: accepted, feedback: accepted ? 'Accepted' : 'Meaning not expressed' };
    }
    if (content.task !== 'FLUENCY') {
      throw new Error('ENCODE 不需要语义评判');
    }
    const fluency = content.content;
    if (fluency.axis === 'R') {
      const questions = fluency.questions;
      return {
        taskId: task.id,
        readingFreeQuestions: questions
          .filter((question) => question.kind === 'free')
          .map((question) => ({ questionId: question.id, correct: true })),
        feedback: 'Reading answers accepted',
      };
    }
    return {
      taskId: task.id,
      production: { targetPassed: true, overallPassed: true },
      feedback: 'Expression accepted',
    };
  }
}

// ── 作答策略：扮演"全会"的学习者 ────────────────────────────────

export interface PreparedAnswer {
  submission: TaskSubmission;
  validity: AttemptValidity;
}

/**
 * 为服务端任务构造全部答对的作答。
 * R 速度按 240 wpm、P 速度按 50 wpm 设计，保证 FLUENCY 通过时流利度越过 80 目标线。
 */
export function correctAnswerFor(task: LearningTask): PreparedAnswer {
  const content = task.content;
  if (content.task === 'ENCODE') {
    return { submission: { task: 'ENCODE' }, validity: { elapsedMs: 30_000, interrupted: false } };
  }
  if (content.task === 'RETRIEVE') {
    const retrieve = content.content;
    if (retrieve.stage === 'choice') {
      return {
        submission: {
          task: 'RETRIEVE',
          stage: 'choice',
          selectedOptionId: retrieve.answerOptionId,
        },
        validity: { elapsedMs: 10_000, interrupted: false },
      };
    }
    return {
      submission: { task: 'RETRIEVE', stage: retrieve.stage, answer: lemmaOfTask(task) },
      validity: { elapsedMs: 20_000, interrupted: false },
    };
  }
  if (content.content.axis === 'R') {
    const reading = content.content;
    const passageWords = reading.passage.trim().split(/\s+/).length;
    return {
      submission: {
        task: 'FLUENCY',
        axis: 'R',
        readingElapsedMs: Math.max(1, Math.round((passageWords * 60_000) / 240)),
        answers: reading.questions.map((question) => question.kind === 'choice'
          ? { questionId: question.id, kind: 'choice' as const, selectedOptionId: question.answerOptionId }
          : { questionId: question.id, kind: 'free' as const, answer: question.answer }),
      },
      validity: { elapsedMs: 120_000, interrupted: false },
    };
  }
  const lemma = content.content.gradingRequirements.targetExpression;
  const response = `When the project failed, our team stayed ${lemma} and honest. `
    + 'We reviewed the setback together, adjusted the plan quickly, and kept moving forward. '
    + 'Everyone shared feedback, protected morale, and built momentum for the next sprint.';
  const responseWords = response.trim().split(/\s+/).length;
  return {
    submission: { task: 'FLUENCY', axis: 'P', response },
    validity: { elapsedMs: Math.max(1, Math.round((responseWords * 60_000) / 50)), interrupted: false },
  };
}

/** 选择题故意答错：选非正确答案的选项。 */
export function wrongChoiceAnswerFor(task: LearningTask): PreparedAnswer {
  const content = task.content;
  if (content.task !== 'RETRIEVE' || content.content.stage !== 'choice') {
    throw new Error('wrongChoiceAnswerFor 只适用于 RETRIEVE 选择题');
  }
  const choice = content.content;
  const wrong = choice.options.find((option) => option.id !== choice.answerOptionId);
  if (!wrong) throw new Error('选择题缺少干扰项');
  return {
    submission: { task: 'RETRIEVE', stage: 'choice', selectedOptionId: wrong.id },
    validity: { elapsedMs: 10_000, interrupted: false },
  };
}

function lemmaOfTask(task: LearningTask): string {
  const lemma = task.content.wordId.split(':')[1];
  if (!lemma) throw new Error(`任务 ${task.id} 的 wordId 不含 lemma`);
  return lemma;
}
