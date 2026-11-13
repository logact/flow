/// <reference types="jest" />

/**
 * S08 生成学习任务的 Live 验证：用真实 LLM 供应商跑大场景五规格。
 * 需要环境变量 LLM_API_KEY（以及可选的 LLM_BASE_URL / LLM_MODEL）：
 *
 *   LLM_API_KEY=xxx npm run test:s8:live
 *
 * 未配置 key 时整个套件跳过；失败的输出会展示 AI 原始返回，便于调整 prompt。
 */

import { createOpenAITaskGenerationProvider } from '../lib/application/openai-task-provider';
import { generateLearningTaskUseCase } from '../lib/application/task-generation';
import { toLearningTaskView, validateGeneratedTask, knowledgePointName } from '../lib/domain/functions';
import {
  createRepository,
  inputFor,
  knowledgePoints,
  specifications,
  type ScenarioKey,
} from './helpers/task-generation-fixture';

const describeLive = process.env.LLM_API_KEY ? describe : describe.skip;

describeLive('S08 生成学习任务（Live：真实 LLM 供应商）', () => {
  jest.setTimeout(180_000);
  const provider = createOpenAITaskGenerationProvider();
  const scenario: Array<{ key: ScenarioKey; name: string }> = [
    { key: 'encodeResilient', name: 'resilient / ENCODE' },
    { key: 'retrieveUbiquitousChoiceR', name: 'ubiquitous / RETRIEVE-R-choice' },
    { key: 'retrieveDeliberateCuedP', name: 'deliberate / RETRIEVE-P-cued' },
    { key: 'fluencyContemporaryR', name: 'contemporary / FLUENCY-R' },
    { key: 'fluencyResilientP', name: 'resilient / FLUENCY-P' },
  ];

  test.each(scenario)('真实供应商生成：$name', async ({ key }) => {
    const { repository } = createRepository();
    const result = await generateLearningTaskUseCase(
      { repository, aiProvider: provider },
      inputFor(key),
    );

    if (!result.ok) {
      throw new Error(`真实供应商生成失败（${key}）：${result.reason}；请检查上方输出与 prompt`);
    }
    // 真实输出必须通过含短文质量校验（80~100 词、目标词≥3 次）的领域校验，且语义上确实指向目标词。
    const knowledgePoint = knowledgePoints.find((item) => item.id === specifications[key].wordId);
    expect(validateGeneratedTask(specifications[key], result.task.content, knowledgePointName(knowledgePoint!))).toBe(true);
    expect(result.task.content.wordId).toBe(specifications[key].wordId);
    // 公开视图不得泄露任何服务端答案材料。
    const serializedView = JSON.stringify(toLearningTaskView(result.task));
    expect(serializedView).not.toContain('answerOptionId');
    expect(serializedView).not.toContain('gradingRequirements');
    expect(serializedView).not.toContain('"evidence"');
    expect(serializedView).not.toContain('"answer"');
  });
});
