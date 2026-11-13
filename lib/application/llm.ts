import { aiLogger, type AppLogger } from './logger';

/**
 * OpenAI 兼容的聊天客户端与供应商配置。
 * 支持 DeepSeek、Kimi、OpenAI 等任何 /chat/completions 兼容端点；
 * 密钥、超时、重试都在这里，不进入 Domain。
 * 请求消息与响应全文都会写入日志便于调试出题；绝不记录 API key，统一写入 logs/ai.log。
 */

export interface LLMConfig {
  apiKey: string;
  /** 形如 https://api.deepseek.com 或 https://api.openai.com/v1，末尾斜杠会被去掉。 */
  baseUrl: string;
  model: string;
}

/** 读取配置所需的最小环境变量形状；完整 process.env 可直接传入。 */
export interface LLMEnv {
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  [key: string]: string | undefined;
}

export const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_LLM_MODEL = 'deepseek-chat';

/** 从环境变量读取供应商配置；缺省使用 DeepSeek。 */
export function loadLLMConfig(env: LLMEnv = process.env): LLMConfig {
  return {
    apiKey: env.LLM_API_KEY ?? '',
    baseUrl: (env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, ''),
    model: env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
  };
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  /** 请求 JSON 模式（response_format: json_object）。 */
  json?: boolean;
  timeoutMs?: number;
  /** 网络错误、5xx 与 429 时的总尝试次数；4xx 一律不重试。 */
  maxAttempts?: number;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    /** HTTP 状态码；网络层错误时为空。 */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}

export interface ChatClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

export class OpenAICompatibleChatClient implements ChatClient {
  constructor(
    private readonly config: LLMConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly logger: AppLogger = aiLogger,
  ) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    if (!this.config.apiKey) {
      throw new AIProviderError('LLM_API_KEY 未配置，无法调用 AI Provider');
    }
    const maxAttempts = options.maxAttempts ?? 3;
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const content = await this.request(messages, options);
        this.logger.info({
          model: this.config.model,
          attempt,
          durationMs: Date.now() - startedAt,
          content,
        }, 'llm 请求成功');
        return content;
      } catch (error) {
        const status = error instanceof AIProviderError ? error.status : null;
        const message = error instanceof Error ? error.message : String(error);
        const retriable = !(error instanceof AIProviderError)
          || status === null
          || status >= 500
          || status === 429;
        if (!retriable || attempt >= maxAttempts) {
          this.logger.error({
            model: this.config.model,
            attempt,
            maxAttempts,
            status,
            error: message,
          }, 'llm 请求失败');
          throw error;
        }
        this.logger.warn({
          model: this.config.model,
          attempt,
          maxAttempts,
          status,
          error: message,
        }, 'llm 请求重试');
      }
    }
  }

  private async request(messages: ChatMessage[], options: ChatOptions): Promise<string> {
    this.logger.info({
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      messageCount: messages.length,
      messages,
    }, 'llm 请求发送');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: options.temperature ?? 0.7,
          ...(options.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        choices?: Array<{ message?: { content?: string | null } }>;
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new AIProviderError(
          `LLM 请求失败：HTTP ${response.status}${payload.error?.message ? `：${payload.error.message}` : ''}`,
          response.status,
        );
      }
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new AIProviderError('LLM 返回内容为空');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 部分模型即使开了 JSON 模式也会包 ```json 代码块，剥离后再交给用例解析。 */
export function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}
