import { lookupPronunciation } from '../lib/application/pronunciation';

const entry = {
  word: 'record',
  phonetics: [{ text: '/ˈrekərd/' }, { audio: '//audio.example/record.mp3' }],
  meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a written account' }] }],
};

describe('Free Dictionary pronunciation lookup', () => {
  test('caches matching IPA, audio URL, source and query time', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => [entry] });
    const result = await lookupPronunciation('record', 'noun', { fetchImpl, now: () => '2026-11-16T00:00:00.000Z' });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.dictionaryapi.dev/api/v2/entries/en/record', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result).toEqual({
      ipa: '/ˈrekərd/',
      audioUrl: 'https://audio.example/record.mp3',
      source: 'Free Dictionary API (dictionaryapi.dev)',
      sourceUrl: 'https://api.dictionaryapi.dev/api/v2/entries/en/record',
      queriedAt: '2026-11-16T00:00:00.000Z',
    });
  });

  test('rejects a same-spelling entry without a matching part of speech', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => [entry] });
    await expect(lookupPronunciation('record', 'verb', { fetchImpl })).resolves.toBeNull();
  });

  test('does not block callers on API errors or malformed responses', async () => {
    await expect(lookupPronunciation('record', 'noun', {
      fetchImpl: jest.fn().mockRejectedValue(new Error('offline')),
    })).resolves.toBeNull();
    await expect(lookupPronunciation('record', 'noun', {
      fetchImpl: jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    })).resolves.toBeNull();
  });
});
