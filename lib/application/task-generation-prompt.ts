import type { ChatMessage } from './llm';
import type { TaskGenerationAIRequest } from './ports';
import type { VocabularyEstimate } from '../domain/model';

/**
 * 出题用的系统提示：静态描述五种 content 结构。
 * 结构要求与 Domain 的 validateGeneratedTask 一一对应，改校验规则时这里要同步。
 */
const TASK_GENERATION_SYSTEM_PROMPT = `你是一款英语词汇学习应用的出题专家。根据任务规格、目标知识点和来源材料生成一项学习任务。

严格只输出一个 JSON 对象：不要 markdown 代码块，不要输出 JSON 以外的任何解释。

顶层结构：{"schemaVersion":"1","task":<任务类型>,"wordId":<知识点ID>,"content":{...}}

通用要求：
- schemaVersion 固定为 "1"；task 与 wordId 必须与任务规格完全一致，不得自行更换单词或题型。
- 所有字符串字段非空；选择题有且只有一个正确选项。
- 题干、例句、短文为英文；场景表达任务的 scenario 与 responseInstruction 为中文且不得泄露目标表达。
- 难度必须匹配用户消息中给出的学习者词汇水平：英文题干、例句、短文与干扰项只使用学习者大概率已掌握的词汇（以给出的各词频段掌握概率为准，掌握概率 ≥0.9 的词段视为已掌握，0.5～0.9 视为部分掌握，<0.5 视为未掌握）；除目标词及其词族外避免使用未掌握词段的词。学习者尚未完成测评时按中等水平（约 4k～5k 词段）出题。

各任务类型的 content 结构：
1. task="ENCODE"：{"word":<词形>,"partOfSpeech":<词性，可省略>,"definition":<词义>,"examples":[{"sentence":<英文例句>,"translation":<中文翻译，可省略>}],"instruction":<给学习者的操作说明>}
2. task="RETRIEVE" stage="choice"：{"axis":<规格维度>,"stage":"choice","prompt":<题干>,"options":[{"id":"a","text":<选项>},...至少2项且id唯一],"answerOptionId":<正确选项id>,"explanation":<答案解释>}
3. task="RETRIEVE" stage="cued"|"free"：{"axis":<规格维度>,"stage":<规格阶段>,"prompt":<题干>,"cue":<简短提示，仅cued阶段>,"answerKey":{"acceptedAnswers":[<可接受的正确答案>],"explanation":<答案解释>}}
4. task="FLUENCY" axis="R"：{"axis":"R","passage":<80-100词的英文短文，目标词至少出现3次>,"questions":[{"id":<稳定ID>,"role":"target_meaning"|"passage_comprehension","kind":"choice"|"free","prompt":<题干>,"evidence":<必须逐字来自passage的证据句>,选择题带"options"+"answerOptionId"，自由题带"answer">}],"targetOccurrences":<目标词在passage中的实际出现次数，整数且≥3，必须与短文一致>}
5. task="FLUENCY" axis="P"：{"axis":"P","scenario":<中文场景>,"responseInstruction":<中文作答说明>,"gradingRequirements":{"targetExpression":<目标英文表达>,"targetUseCriteria":[<目标表达使用标准>],"overallExpressionCriteria":[<整体表达标准>]}}`;

/** 组装任务生成消息：系统提示为静态结构说明，用户消息携带本次规格、知识点、学习者水平与来源材料。 */
export function buildTaskGenerationMessages(request: TaskGenerationAIRequest): ChatMessage[] {
  return [
    { role: 'system', content: TASK_GENERATION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        '任务规格：',
        JSON.stringify(request.specification),
        '',
        '目标知识点：',
        JSON.stringify(request.knowledgePoint),
        '',
        '学习者词汇水平：',
        formatLearnerVocabulary(request.learnerVocabulary),
        '',
        '来源材料：',
        JSON.stringify(request.sourceMaterials.map((material) => ({
          title: material.title,
          text: material.extractedText,
        }))),
        ...(request.feedback
          ? ['', `上次生成未通过校验：${request.feedback}。请针对以上问题修正后重新生成，只输出修正后的完整 JSON。`]
          : []),
        '',
        '请生成任务 JSON。',
      ].join('\n'),
    },
  ];
}

/** 把词汇估计格式化为人类可读的水平摘要，供 AI 据其控制题目难度。 */
export function formatLearnerVocabulary(estimate: VocabularyEstimate | null): string {
  if (!estimate) {
    return '学习者尚未完成词汇测评，按中等水平（约 4k～5k 词段）出题。';
  }
  const lines = estimate.bands.map((band) => {
    const known = band.sampleCount > 0 ? `，抽样 ${band.sampleCount} 词族认识 ${band.knownCount}` : '';
    return `- ${band.band} 词段：掌握概率 ${band.knownProbability}${known}`;
  });
  return [
    `最近一次测评（词表 ${estimate.list.id} v${estimate.list.version}，${estimate.estimatedAt}）各词频段掌握概率：`,
    ...lines,
  ].join('\n');
}
