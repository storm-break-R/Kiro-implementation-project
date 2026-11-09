import { ThemeProvider } from '@mui/material';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AuthProvider } from '../auth/AuthContext';
import { theme } from '../theme';

export function renderWithProviders(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  return render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

type Handler = (init: RequestInit | undefined, url: string) => { status?: number; body?: unknown };

/** Replace global fetch with route handlers keyed by "METHOD /path". Unhandled calls fail loudly. */
export function mockFetch(handlers: Record<string, Handler | Handler[]>) {
  const queues = new Map<string, Handler[]>(
    Object.entries(handlers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
  );
  const calls: Array<{ key: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push({ key, init });
    const queue = queues.get(key);
    const handler = queue && (queue.length > 1 ? queue.shift()! : queue[0]!);
    if (!handler) throw new Error(`Unhandled fetch: ${key}`);
    const { status = 200, body } = handler(init, url);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}
