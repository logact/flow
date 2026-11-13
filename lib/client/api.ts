/** 客户端 API 访问辅助：统一错误形状，页面组件只处理 reason。 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { reason?: string; message?: string })
    | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.reason ?? null,
      payload?.message ?? `请求失败（HTTP ${response.status}）`,
    );
  }
  return payload as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });
}
