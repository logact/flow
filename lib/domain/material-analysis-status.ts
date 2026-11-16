import type { MaterialAnalysis } from './model';

export type MaterialAnalysisStatus = MaterialAnalysis['status'] | null;

export function materialAnalysisProgressLabel(stage: string | null | undefined): string | null {
  if (!stage) return null;
  const labels: Record<string, string> = {
    starting: '正在启动',
    extracting_terms: '正在整理材料词汇',
    resolving_senses: '正在判断词义',
    translating_meanings: '正在补全释义',
    looking_up_pronunciation: '正在查询发音',
    saving_results: '正在保存分析结果',
  };
  return labels[stage] ?? null;
}

/** Shared user-facing labels for material analysis status. */
export function materialAnalysisStatusLabel(status: MaterialAnalysisStatus, view: 'list' | 'detail'): string {
  if (status === 'pending') return '分析中';
  if (status === 'analyzed') return '分析完成';
  if (status === 'failed') return '分析失败';
  return view === 'list' ? '未分析' : '未开始';
}

export function isMaterialAnalysisStale(status: MaterialAnalysisStatus, createdAt: string | null | undefined, now = Date.now()): boolean {
  if (status !== 'pending' || !createdAt) return false;
  const age = now - Date.parse(createdAt);
  return !Number.isFinite(age) || age >= 6 * 60 * 1000;
}
