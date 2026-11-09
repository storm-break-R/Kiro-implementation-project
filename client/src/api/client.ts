export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const REFRESH_KEY = 'sv.refresh';

/**
 * Access token lives in memory only. The refresh token is kept in sessionStorage
 * (cleared when the tab closes) so a page reload doesn't log the user out.
 */
let accessToken: string | null = null;
let onSessionExpired: (() => void) | null = null;

export const tokenStore = {
  getAccess: () => accessToken,
  getRefresh: () => sessionStorage.getItem(REFRESH_KEY),
  set(access: string, refresh: string) {
    accessToken = access;
    sessionStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    accessToken = null;
    sessionStorage.removeItem(REFRESH_KEY);
  },
  setExpiredHandler(handler: (() => void) | null) {
    onSessionExpired = handler;
  },
};

let refreshing: Promise<boolean> | null = null;

/** Single-flight: concurrent 401s share one refresh (refresh tokens are single use). */
function refreshTokens(): Promise<boolean> {
  refreshing ??= (async () => {
    const refreshToken = tokenStore.getRefresh();
    if (!refreshToken) return false;
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken: string; refreshToken: string };
      tokenStore.set(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** JSON body */
  body?: unknown;
  /** Multipart body (mutually exclusive with `body`) */
  form?: FormData;
  /** Send the Authorization header (default true when a token exists) */
  auth?: boolean;
  signal?: AbortSignal;
}

async function rawRequest(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    signal: opts.signal,
  });
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  let res = await rawRequest(path, opts);
  if (res.status === 401 && opts.auth !== false && tokenStore.getRefresh()) {
    if (await refreshTokens()) {
      res = await rawRequest(path, opts);
    } else {
      tokenStore.clear();
      onSessionExpired?.();
    }
  }
  return res;
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const data = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    return new ApiError(
      res.status,
      data.error?.code ?? 'ERROR',
      data.error?.message ?? res.statusText,
      data.error?.details,
    );
  } catch {
    return new ApiError(res.status, 'ERROR', res.statusText || 'Request failed');
  }
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, opts);
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Authenticated file download (CSV exports). */
export async function apiBlob(path: string, opts: RequestOptions = {}): Promise<{ blob: Blob; filename: string }> {
  const res = await send(path, opts);
  if (!res.ok) throw await toError(res);
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  return { blob: await res.blob(), filename: match?.[1] ?? 'download' };
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
