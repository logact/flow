import 'server-only';

/** Safe categories for failures from the configured OpenAI-compatible provider. */
export type LlmErrorCode =
  | 'missing_config'
  | 'invalid_config'
  | 'timeout'
  | 'http_error'
  | 'malformed_response'
  | 'invalid_json'
  | 'schema_mismatch';

export class LlmError extends Error {
  constructor(readonly code: LlmErrorCode) {
    // Deliberately omit request/response contents and all environment values.
    super(`LLM request failed (${code})`);
    this.name = 'LlmError';
  }
}

export interface LlmJsonRequest<T> {
  system: string;
  user: string;
  /** Validate and narrow untrusted JSON before returning it to application code. */
  validate: (value: unknown) => value is T;
  timeoutMs?: number;
}

type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  nativeLanguage: string;
};

function readConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env.LLM_API_KEY?.trim();
  const baseUrl = env.LLM_BASE_URL?.trim();
  const model = env.LLM_MODEL?.trim();
  const nativeLanguage = env.LLM_NATIVE_LANGUAGE?.trim();
  if (!apiKey || !baseUrl || !model || !nativeLanguage) {
    throw new LlmError('missing_config');
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new LlmError('invalid_config');
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') {
    throw new LlmError('invalid_config');
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model, nativeLanguage };
}

/** Expose only the native language setting; credentials remain private to this module. */
export function getLlmNativeLanguage(): string {
  return readConfig().nativeLanguage;
}

/**
 * Call an OpenAI-compatible chat-completions endpoint and return validated JSON.
 * Provider error bodies are intentionally discarded so they cannot leak prompts
 * or credentials into logs or UI error messages.
 */
export async function requestLlmJson<T>(request: LlmJsonRequest<T>): Promise<T> {
  const config = readConfig();
  const timeoutMs = request.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new LlmError('invalid_config');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `${request.system}\n\nWrite any learner-facing text in ${config.nativeLanguage}. Return one JSON object only.`,
            },
            { role: 'user', content: request.user },
          ],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new LlmError('timeout');
      }
      throw new LlmError('http_error');
    }

    if (!response.ok) throw new LlmError('http_error');
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new LlmError('malformed_response');
    }
    if (
      envelope == null || typeof envelope !== 'object' ||
      !('choices' in envelope) || !Array.isArray(envelope.choices) ||
      envelope.choices.length === 0 || envelope.choices[0] == null ||
      typeof envelope.choices[0] !== 'object' ||
      !('message' in envelope.choices[0]) || envelope.choices[0].message == null ||
      typeof envelope.choices[0].message !== 'object' ||
      !('content' in envelope.choices[0].message) ||
      typeof envelope.choices[0].message.content !== 'string'
    ) throw new LlmError('malformed_response');

    let value: unknown;
    try {
      value = JSON.parse(envelope.choices[0].message.content);
    } catch {
      throw new LlmError('invalid_json');
    }
    if (!request.validate(value)) throw new LlmError('schema_mismatch');
    return value;
  } finally {
    clearTimeout(timer);
  }
}
