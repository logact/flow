import type { MaterialAnalysis } from './model';

export type MaterialAnalysisStatus = MaterialAnalysis['status'] | null;

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
  return !Number.isFinite(age) || age >= 2 * 60 * 1000;
}
