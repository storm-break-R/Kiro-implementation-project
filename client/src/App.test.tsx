import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { mockFetch, renderWithProviders } from './test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('App shell', () => {
  it('renders the header, navigation and the open events', async () => {
    mockFetch({
      'GET /api/events': () => ({
        body: {
          events: [
            {
              id: 'e1',
              title: 'Player of the Season',
              status: 'open',
              endsAt: '2030-01-01T00:00:00.000Z',
              startsAt: '2029-01-01T00:00:00.000Z',
            },
          ],
        },
      }),
    });
    renderWithProviders(<App />);

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Player of the Season' })).toBeInTheDocument();
  });

  it('sends anonymous visitors away from admin pages', async () => {
    mockFetch({});
    renderWithProviders(<App />, { route: '/admin' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
