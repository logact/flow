import { CONFIG } from './config';
import type { Word } from './db';

// 任务库（RPD「任务库」表）：资格谓词替代旧的段位→题型查表。
// 调度以 (KP, 方向, 任务) 三元组为候选——先由资格谓词定任务，后算 P。

export type Axis = 'p' | 'r';
export type ScoredKind = 'STEP3' | 'STEP4' | 'STEP4R' | 'MFI';

export interface Candidate {
  dir: Axis;
  kind: ScoredKind;
}

// 材料长度（词数）：Step 4 写作示范句 / Step 4R 速读篇章共用同一份 per-KP 材料
export const materialWords = (w: Word) =>
  w.step4_sentences.join(' ').split(/\s+/).filter(Boolean).length;

// 有可测的阅读构念：材料够长才谈得上速读。短材料词（词表导入只有语块本身）
// 的 F_R 改为镜像 F_P——它们的流利度按定义就是单一构念（见 RPD「P⊃R 迁移」）
export const readable = (w: Word) => materialWords(w) >= CONFIG.READ_MIN_WORDS;

// 同轴平局时的任务偏好：同一根轴上各候选的 gap/urgency 相同，P 必然相等，
// 由任务秩决定派哪个——信息更丰富的构念优先（P 轴 STEP4 > STEP3；R 轴 MFI > STEP4R）
const TASK_RANK: Record<ScoredKind, number> = { MFI: 0, STEP4: 1, STEP4R: 2, STEP3: 3 };
export const taskRank = (k: ScoredKind): number => TASK_RANK[k];

// 资格谓词保证「先准确后速度」无需档位：F 低于 ACCURACY_FLOOR 时速度任务不可派，
// 候选自然落回提取类任务。新词（last_ts = 0）走引入通道，不参与复习竞争。
export function candidatesOf(w: Word, hasBook: boolean): Candidate[] {
  if (w.last_ts === 0) return [];
  const out: Candidate[] = [{ dir: 'p', kind: 'STEP3' }];
  if (w.fluency >= CONFIG.ACCURACY_FLOOR) out.push({ dir: 'p', kind: 'STEP4' });
  if (w.fluency_r >= CONFIG.ACCURACY_FLOOR) {
    if (readable(w)) out.push({ dir: 'r', kind: 'STEP4R' });
    if (hasBook) out.push({ dir: 'r', kind: 'MFI' });
  }
  return out;
}
