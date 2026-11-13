'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPut, ApiError } from '@/lib/client/api';
import type { LearnerResponse } from '@/lib/client/types';
import { PageShell } from '@/components/PageShell';

/** 个人中心：学习设置（S01 更新）与词汇水平估计。 */
export default function MePage() {
  const router = useRouter();
  const [data, setData] = useState<LearnerResponse | null>(null);
  const [capacity, setCapacity] = useState(12);
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await apiGet<LearnerResponse>('/api/learner');
      setData(response);
      setCapacity(response.learner.dailyTaskCapacity);
      setTimezone(response.learner.timezone);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败，请刷新。');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      await apiPut('/api/learner', { dailyTaskCapacity: capacity, timezone });
      setMessage('设置已保存；下一次生成计划时生效。');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  }, [capacity, timezone, load]);

  return (
    <PageShell title="我">
      {error && <p className="doc-error">{error}</p>}
      {message && <p className="doc-notice">{message}</p>}

      {data && (
        <>
          <section className="doc-card">
            <h2>学习设置</h2>
            <div className="doc-form-row">
              <label>
                每日任务容量
                <input type="number" min={1} max={50} value={capacity} onChange={(event) => setCapacity(Number(event.target.value))} />
              </label>
              <label>
                时区
                <input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Asia/Shanghai" />
              </label>
            </div>
            <div className="doc-actions">
              <button className="primary-button" disabled={saving} onClick={() => void save()}>
                {saving ? '保存中…' : '保存设置'}
              </button>
            </div>
            <p className="doc-muted">
              AI 服务：{data.llmConfigured ? '已配置（任务生成与 AI 评判可用）' : '未配置 LLM_API_KEY，出题与 AI 评判不可用'}
            </p>
          </section>

          <section className="doc-card">
            <h2>词汇水平</h2>
            {data.learner.currentVocabulary ? (
              <table className="doc-table">
                <thead><tr><th>词段</th><th>掌握概率</th><th>认识 / 抽样</th></tr></thead>
                <tbody>
                  {data.learner.currentVocabulary.bands.map((band) => (
                    <tr key={band.band}>
                      <td>{band.band}</td>
                      <td>{(band.knownProbability * 100).toFixed(0)}%</td>
                      <td>{band.knownCount} / {band.sampleCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="doc-muted">尚未完成词汇测评。</p>
            )}
            <div className="doc-actions">
              <button className="text-button" onClick={() => router.push('/setup')}>{data.learner.currentVocabulary ? '重新测评' : '去测评'}</button>
            </div>
          </section>

          <section className="doc-card">
            <h2>数据概览</h2>
            <p className="doc-muted">
              材料 {data.counts.materials} · 目标 {data.counts.goals} · 任务 {data.counts.tasks} · 作答 {data.counts.attempts}
            </p>
            <p className="doc-muted">原型阶段数据保存在服务进程内存中，重启后重置。</p>
          </section>
        </>
      )}
    </PageShell>
  );
}
