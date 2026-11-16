import { OpenAICompatibleChatClient, loadLLMConfig } from './llm';

const cache = new Map<string, Promise<string | null>>();

/** Translate one dictionary sense gloss once per server process; null means unavailable. */
export function createSenseMeaningTranslator(env: Parameters<typeof loadLLMConfig>[0] = process.env) {
  const client = new OpenAICompatibleChatClient(loadLLMConfig(env));
  return (senseId: string, englishDefinition: string): Promise<string | null> => {
    const key = `${senseId}\0${englishDefinition}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = client.chat([
      { role: 'system', content: 'Translate the English dictionary sense definition into a concise, accurate Simplified Chinese meaning. Return only the Chinese translation.' },
      { role: 'user', content: englishDefinition },
    ], { temperature: 0.1 }).then(value => {
      const translated = value.trim() || null;
      if (!translated) cache.delete(key);
      return translated;
    }).catch(() => {
      cache.delete(key);
      return null;
    });
    cache.set(key, pending);
    return pending;
  };
}
