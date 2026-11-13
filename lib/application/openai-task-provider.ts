import {
  OpenAICompatibleChatClient,
  loadLLMConfig,
  stripCodeFences,
  type ChatClient,
  type LLMEnv,
} from './llm';
import { aiLogger, type AppLogger } from './logger';
import type { TaskGenerationAIProvider, TaskGenerationAIRequest } from './ports';
import { buildTaskGenerationMessages } from './task-generation-prompt';

/**
 * 基于 OpenAI 兼容端点的任务生成 Provider。
 * 输出为原始文本（已剥离代码块围栏），解析与结构校验由 S08 用例完成；
 * 日志统一写入 logs/ai.log。
 */
export class OpenAITaskGenerationProvider implements TaskGenerationAIProvider {
  constructor(
    private readonly client: ChatClient,
    private readonly logger: AppLogger = aiLogger,
  ) {}

  async generateTask(request: TaskGenerationAIRequest): Promise<string> {
    const raw = await this.client.chat(buildTaskGenerationMessages(request), {
      json: true,
      temperature: 0.7,
    });
    const stripped = stripCodeFences(raw);
    this.logger.debug({ outputLength: stripped.length }, '任务生成：AI 原始输出已接收');
    return stripped;
  }
}

/** 用环境变量配置创建默认 Provider；供 Live 验证与运行时使用。 */
export function createOpenAITaskGenerationProvider(
  env: LLMEnv = process.env,
): OpenAITaskGenerationProvider {
  return new OpenAITaskGenerationProvider(new OpenAICompatibleChatClient(loadLLMConfig(env)));
}
