import type { PronunciationMetadata } from '../domain/model';

const SOURCE = 'Free Dictionary API (dictionaryapi.dev)';

/** 查询与词条匹配的词典发音。词性无法关联、数据无效或请求失败时返回 null。 */
export async function lookupPronunciation(
  lemma: string,
  partOfSpeech: string | null,
  options: { fetchImpl?: typeof fetch; now?: () => string; timeoutMs?: number } = {},
): Promise<PronunciationMetadata | null> {
  const normalizedLemma = lemma.trim();
  if (!normalizedLemma) return null;
  const sourceUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(normalizedLemma)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
  try {
    const response = await (options.fetchImpl ?? fetch)(sourceUrl, { signal: controller.signal });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) return null;
    const entry = payload.find((item) => item && typeof item === 'object'
      && typeof item.word === 'string' && item.word.toLocaleLowerCase() === normalizedLemma.toLocaleLowerCase()
      && Array.isArray(item.meanings)
      && (!partOfSpeech || item.meanings.some((meaning: any) => typeof meaning?.partOfSpeech === 'string'
        && meaning.partOfSpeech.toLocaleLowerCase() === partOfSpeech.toLocaleLowerCase())));
    if (!entry) return null;
    const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
    const ipaEntry = phonetics.find((item: any) => typeof item?.text === 'string' && item.text.trim());
    const audioEntry = phonetics.find((item: any) => typeof item?.audio === 'string' && item.audio.trim());
    const ipa = typeof ipaEntry?.text === 'string' ? ipaEntry.text.trim() : null;
    const rawAudio = typeof audioEntry?.audio === 'string' ? audioEntry.audio.trim() : null;
    const audioUrl = rawAudio ? new URL(rawAudio, 'https://api.dictionaryapi.dev').toString() : null;
    if (!ipa && !audioUrl) return null;
    return {
      ipa,
      audioUrl,
      source: SOURCE,
      sourceUrl,
      queriedAt: (options.now ?? (() => new Date().toISOString()))(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
