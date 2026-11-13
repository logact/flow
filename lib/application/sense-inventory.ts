import { readFileSync } from 'node:fs';
import type { InventorySense, SenseInventory } from './ports';

/** data/sense-inventory-v1.json 的行结构：[id, lemma, pos, gloss]。 */
type InventoryRow = [string, string, string, string];

/** 从版本化 JSON 词义库文件构建 SenseInventory；输入 lemma 统一按英文小写查询。 */
export function loadSenseInventoryFromFile(filePath: string): SenseInventory {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  const senses = (parsed as { senses?: unknown }).senses;
  if (!Array.isArray(senses)) throw new Error('sense inventory file must contain a senses array');
  const byLemma = new Map<string, InventorySense[]>();
  senses.forEach((row, index) => {
    if (!Array.isArray(row) || row.length !== 4 || row.some((field) => typeof field !== 'string')) {
      throw new Error(`sense inventory row ${index} must be [id, lemma, pos, gloss] strings`);
    }
    const [id, lemma, pos, gloss] = row as InventoryRow;
    const entry: InventorySense = { id, pos, gloss };
    const list = byLemma.get(lemma);
    if (list) {
      list.push(entry);
    } else {
      byLemma.set(lemma, [entry]);
    }
  });
  return {
    lookup(lemma: string): InventorySense[] {
      return byLemma.get(lemma.toLocaleLowerCase('en')) ?? [];
    },
  };
}
