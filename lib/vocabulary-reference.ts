import fullList from '../data/bnc-coca-l6-v2.0.0.json';
/** BNC/COCA Level 6 v2.0.0 local reference adapter. */
export const VOCABULARY_LIST_VERSION = '2.0.0' as const;
export const VOCABULARY_LIST_SOURCE = { id: 'BNC_COCA_L6_v2', basis: 'word-family-frequency-band' } as const;
export type WordFamilyBand = `${number}k`;
export interface WordFamily { id: string; headword: string; band: WordFamilyBand; members: string[]; memberFrequencies?: Record<string, number>; totalFrequency?: number; pos?: string[] }
export interface FamilyLookup { status: 'matched' | 'not_in_list' | 'ambiguous'; source: string; version: string; matchedForm?: string; family?: WordFamily; candidates?: WordFamily[] }
export interface FamilyList { source: string; version: string; families: WordFamily[] }
export const BNC_COCA_L6_V2 = fullList as FamilyList;
export function createFamilyListIndex(list: FamilyList) {
  if (!list.source || !list.version) throw new RangeError('source and version are required');
  const forms = new Map<string, WordFamily[]>(); const ids = new Set<string>();
  for (const f of list.families) {
    if (!f.id || !f.headword.trim() || !/^([1-9]|1[0-9]|2[0-5])k$/.test(f.band) || !f.members.length || ids.has(f.id)) throw new RangeError(`invalid or duplicate family: ${f.id}`);
    ids.add(f.id);
    for (const form of [f.headword, ...f.members]) { const key = norm(form); if (!key) throw new RangeError('empty family member'); const arr = forms.get(key) ?? []; if (!arr.some(x => x.id === f.id)) arr.push(f); forms.set(key, arr); }
  }
  return { source: list.source, version: list.version, lookup(form: string, options: { partOfSpeech?: string } = {}): FamilyLookup {
    const key = norm(form), all = forms.get(key) ?? [];
    const candidates = options.partOfSpeech ? all.filter(f => !f.pos?.length || f.pos.includes(options.partOfSpeech!)) : all;
    if (!candidates.length) return { status: 'not_in_list', source: list.source, version: list.version };
    if (candidates.length > 1) return { status: 'ambiguous', source: list.source, version: list.version, matchedForm: form, candidates: candidates.map(x => ({ ...x })) };
    return { status: 'matched', source: list.source, version: list.version, matchedForm: form, family: { ...candidates[0], members: [...candidates[0].members] } };
  } };
}
export const bncCocaFamilyIndex = createFamilyListIndex(BNC_COCA_L6_V2);
/** Cumulative family boundaries are derived from counts per frequency band, never token frequencies. */
export function getBncCocaBandBounds(): Array<{band: WordFamilyBand; lower:number; upper:number}> {
  const counts = new Map<string, number>();
  for (const family of BNC_COCA_L6_V2.families) counts.set(family.band, (counts.get(family.band) ?? 0) + 1);
  let lower=1;
  return [...counts].sort((a,b)=>parseInt(a[0])-parseInt(b[0])).map(([band,count])=>{const row={band:band as WordFamilyBand,lower,upper:lower+count-1};lower+=count;return row;});
}
function norm(s: string) { return s.normalize('NFKC').trim().toLocaleLowerCase('en'); }
