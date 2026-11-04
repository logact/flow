import { BANDS, NONWORDS } from './vocab-data';

const PER_BAND = 4;
const NONWORD_COUNT = 3;

export interface AssessItem {
  word: string;
}

// 每个频率段随机抽 PER_BAND 个，加 NONWORD_COUNT 个伪词，整体打乱
export function sampleTest(): AssessItem[] {
  const items: AssessItem[] = [];
  for (const b of BANDS) {
    const picked = [...b.words].sort(() => Math.random() - 0.5).slice(0, PER_BAND);
    for (const w of picked) items.push({ word: w });
  }
  const fakes = [...NONWORDS].sort(() => Math.random() - 0.5).slice(0, NONWORD_COUNT);
  for (const w of fakes) items.push({ word: w });
  return items.sort(() => Math.random() - 0.5);
}

export interface AssessResult {
  raw: number;
  estimate: number;
  nonwordsClaimed: number;
  label: string;
  ielts: string;
  bandDetail: { band: number; known: number; total: number }[];
}

export function score(answers: { word: string; known: boolean }[]): AssessResult {
  let raw = 0;
  const bandDetail: AssessResult['bandDetail'] = [];
  for (const b of BANDS) {
    const pool = new Set(b.words);
    const ans = answers.filter((a) => pool.has(a.word));
    const known = ans.filter((a) => a.known).length;
    if (ans.length > 0) {
      raw += (known / ans.length) * 1000;
      bandDetail.push({ band: b.band, known, total: ans.length });
    }
  }
  let nonwordsClaimed = 0;
  for (const a of answers) {
    if (NONWORDS.includes(a.word) && a.known) nonwordsClaimed++;
  }
  // 每个虚报的伪词扣减 15%，惩罚虚报倾向（testyourvocab 同款思路）
  const estimate = Math.max(0, Math.round(raw * (1 - 0.15 * nonwordsClaimed)));
  return { raw: Math.round(raw), estimate, nonwordsClaimed, bandDetail, ...levelOf(estimate) };
}

export function levelOf(estimate: number): { label: string; ielts: string } {
  if (estimate < 2000) return { label: '入门（≈ CEFR A1-A2）', ielts: '< 4.5' };
  if (estimate < 4000) return { label: '中级（≈ CEFR B1）', ielts: '4.5 - 5.5' };
  if (estimate < 6000) return { label: '中高级（≈ CEFR B2）', ielts: '5.5 - 6.5' };
  if (estimate < 8000) return { label: '高级（≈ CEFR C1）', ielts: '6.5 - 7.5' };
  return { label: '精通（≈ CEFR C1+/C2）', ielts: '7.5+' };
}
