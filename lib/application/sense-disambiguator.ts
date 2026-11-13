import { aiLogger, logger as defaultLogger, type AppLogger } from './logger';
import type { SenseDisambiguationItem, SenseDisambiguator } from './ports';

/**
 * 构建发送给 AI 的 user prompt。
 * 候选义项表按 lemma 只列一次（高词频 lemma 的候选表不随出现次数重复），
 * 同一 lemma 的多处出现连续排列，便于模型对照全部语境一致判定。
 */
export function buildDisambiguationPrompt(items: SenseDisambiguationItem[]): string {
  const groups = new Map<string, SenseDisambiguationItem[]>();
  for (const item of items) {
    const group = groups.get(item.lemma);
    if (group) {
      group.push(item);
    } else {
      groups.set(item.lemma, [item]);
    }
  }
  const blocks = [...groups.entries()].map(([lemma, group]) => {
    const candidates = group[0].candidates;
    return [
      `lemma: ${lemma}`,
      'candidate senses:',
      ...candidates.map((candidate) => `- ${candidate.id} (${candidate.pos}) ${candidate.gloss}`),
      'occurrences:',
      ...group.map((item) => [
        `- key: ${item.key}`,
        `  sentence: ${item.sentence}`,
        ...(item.context.length > 0 ? [`  context: ${item.context.join(' | ')}`] : []),
      ].join('\n')),
    ].join('\n');
  });
  return [
    'Identify the correct WordNet sense for each occurrence of the lemma in its sentence.',
    'Candidate senses are listed once per lemma; pick one candidate id for every key.',
    'Return only a JSON array with exactly one object per key:',
    '[{ "key": "<key>", "senseId": "<one of the candidate ids for that lemma>" }]',
    'Every key must appear exactly once; pick the sense that best matches the usage in the sentence.',
    '',
    ...blocks,
  ].join('\n');
}

/**
 * 解析并校验 AI 消歧输出：必须是非空 JSON 数组，
 * 每条 {key, senseId} 的 key 必须存在且 senseId 属于该条目的候选集。
 */
export function parseSenseDisambiguation(
  content: string,
  items: SenseDisambiguationItem[],
): Array<{ key: string; senseId: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('sense disambiguation returned invalid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('sense disambiguation result must be a non-empty JSON array');
  }
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object'
      || typeof (entry as { key?: unknown }).key !== 'string'
      || typeof (entry as { senseId?: unknown }).senseId !== 'string') {
      throw new Error(`sense disambiguation result[${index}] must contain key and senseId`);
    }
    const { key, senseId } = entry as { key: string; senseId: string };
    const item = itemByKey.get(key);
    if (!item) throw new Error(`sense disambiguation returned unknown key: ${key}`);
    if (!item.candidates.some((candidate) => candidate.id === senseId)) {
      throw new Error(`sense disambiguation returned senseId outside candidates: ${senseId}`);
    }
    return { key, senseId };
  });
}

export interface HttpSenseDisambiguatorOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  fetchImpl?: typeof fetch;
  logger?: AppLogger;
  /** AI 交互审计 logger：完整记录请求 prompt 与原始响应；缺省为 AI 链路 logger（logs/ai.log）。 */
  auditLogger?: AppLogger;
}

/** OpenAI 兼容聊天接口的词义消歧实现，可用于 OpenAI、DeepSeek、Kimi 等供应商。 */
export function createHttpSenseDisambiguator(options: HttpSenseDisambiguatorOptions): SenseDisambiguator {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseURL = options.baseURL.replace(/\/+$/, '');
  const logger = options.logger ?? defaultLogger;
  const audit = options.auditLogger ?? aiLogger;
  return {
    async disambiguate(items) {
      if (items.length === 0) return [];
      const prompt = buildDisambiguationPrompt(items);
      logger.debug(
        {
          model: options.model,
          itemCount: items.length,
          items: items.map((item) => ({
            key: item.key,
            lemma: item.lemma,
            candidates: item.candidates.map((candidate) => candidate.id),
          })),
        },
        '词义消歧：AI 请求',
      );
      logger.debug({ prompt: prompt.slice(0, 10000) }, '词义消歧：AI 请求 prompt');
      audit.info(
        { call: 'sense-disambiguation', phase: 'request', model: options.model, itemCount: items.length, prompt },
        'AI 交互：词义消歧请求',
      );
      let content: string;
      try {
        const response = await fetchImpl(`${baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: 'You identify the intended WordNet senses of English words in context. Reply with JSON only.',
              },
              { role: 'user', content: prompt },
            ],
          }),
        });
        if (!response.ok) throw new Error(`sense disambiguation request failed with status ${response.status}`);
        const payload: unknown = await response.json();
        const text = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
          ?.choices?.[0]?.message?.content;
        if (typeof text !== 'string') throw new Error('sense disambiguation response is missing message content');
        content = text;
      } catch (error) {
        audit.error(
          {
            call: 'sense-disambiguation',
            phase: 'request-error',
            model: options.model,
            itemCount: items.length,
            error: error instanceof Error ? error.message : String(error),
          },
          'AI 交互：词义消歧失败',
        );
        throw error;
      }
      logger.debug({ raw: content.slice(0, 8000) }, '词义消歧：AI 原始返回');
      audit.info(
        { call: 'sense-disambiguation', phase: 'response', model: options.model, itemCount: items.length, raw: content },
        'AI 交互：词义消歧响应',
      );
      return parseSenseDisambiguation(content, items);
    },
  };
}

export function createSenseDisambiguatorFromEnv(
  env: Record<string, string | undefined> = process.env,
  appLogger?: AppLogger,
  auditLogger?: AppLogger,
): SenseDisambiguator {
  return createHttpSenseDisambiguator({
    apiKey: env.LLM_API_KEY ?? '',
    baseURL: env.LLM_BASE_URL ?? 'https://api.deepseek.com',
    model: env.LLM_MODEL ?? 'deepseek-chat',
    logger: appLogger,
    auditLogger: auditLogger ?? aiLogger,
  });
}
