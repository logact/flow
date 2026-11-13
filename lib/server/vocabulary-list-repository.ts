import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { VocabularyListRepository } from '../application/vocabulary-assessment';
import type { VocabularyAssessmentWordFamily } from '../domain/functions';
import type { VocabularyBand, VocabularyListReference } from '../domain/model';

/** data/bnc-coca-l6-v2.0.0.json 的词族记录结构（memberFrequencies 在此不需要）。 */
interface FamilyRecord {
  id?: unknown;
  headword?: unknown;
  band?: unknown;
  members?: unknown;
}

const DEFAULT_LIST_PATH = path.join(process.cwd(), 'data', 'bnc-coca-l6-v2.0.0.json');

interface LoadedList {
  families: VocabularyAssessmentWordFamily[];
  bandWordFamilyCounts: Partial<Record<VocabularyBand, number>>;
}

const cache = new Map<string, LoadedList>();

function loadList(filePath: string): LoadedList {
  const cached = cache.get(filePath);
  if (cached) return cached;
  const raw: { families?: FamilyRecord[] } = JSON.parse(readFileSync(filePath, 'utf8'));
  const families: VocabularyAssessmentWordFamily[] = [];
  const bandWordFamilyCounts: Partial<Record<VocabularyBand, number>> = {};
  for (const family of raw.families ?? []) {
    if (typeof family.id !== 'string' || typeof family.headword !== 'string' || typeof family.band !== 'string') {
      continue;
    }
    const band = family.band as VocabularyBand;
    families.push({
      id: family.id,
      headword: family.headword,
      band,
      members: Array.isArray(family.members) ? family.members.map(String) : [family.headword],
      pos: [],
    });
    bandWordFamilyCounts[band] = (bandWordFamilyCounts[band] ?? 0) + 1;
  }
  const loaded: LoadedList = { families, bandWordFamilyCounts };
  cache.set(filePath, loaded);
  return loaded;
}

/**
 * 从本地版本化 BNC/COCA 词族清单构建词表端口。
 * 请求的词表版本与文件版本不一致时抛出，避免混用词段统计。
 */
export function createFileVocabularyListRepository(
  filePath: string = DEFAULT_LIST_PATH,
): VocabularyListRepository {
  const raw: { version?: unknown } = JSON.parse(readFileSync(filePath, 'utf8'));
  const fileVersion = String(raw.version ?? '');
  return {
    async loadWordFamilies(list: VocabularyListReference): Promise<VocabularyAssessmentWordFamily[]> {
      if (fileVersion && list.version !== fileVersion) {
        throw new Error(`Vocabulary list version mismatch: requested ${list.version}, file has ${fileVersion}`);
      }
      return loadList(filePath).families;
    },
    async loadBandWordFamilyCounts(
      list: VocabularyListReference,
    ): Promise<Partial<Record<VocabularyBand, number>>> {
      if (fileVersion && list.version !== fileVersion) {
        throw new Error(`Vocabulary list version mismatch: requested ${list.version}, file has ${fileVersion}`);
      }
      return loadList(filePath).bandWordFamilyCounts;
    },
  };
}

/** 词表引用：与 data/bnc-coca-l6-v2.0.0.json 的 source/version 对齐。 */
export const BNC_COCA_L6: VocabularyListReference = { id: 'bnc-coca-l6', version: '2.0.0' };
