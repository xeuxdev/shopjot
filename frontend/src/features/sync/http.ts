export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const apiOrigin = (import.meta.env.VITE_API_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
  const response = await fetch(`${apiOrigin}/api${path}`, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const data: unknown = await response.json().catch(() => {
    throw new Error(
      'The backup server returned an unreadable response. Your records remain on this phone.',
    );
  });
  if (!response.ok) {
    const error = data as { code?: string; message?: string };
    throw new HttpError(
      response.status,
      error.code ?? 'SERVER_ERROR',
      error.message ?? 'The backup request did not succeed.',
    );
  }
  return data;
}
