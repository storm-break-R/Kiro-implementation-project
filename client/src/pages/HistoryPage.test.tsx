import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { mockFetch, renderWithProviders } from '../test/utils';

afterEach(() => vi.unstubAllGlobals());

const item = (over: Record<string, unknown>) => ({
  eventId: 'e1',
  title: 'Player of the Season',
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2026-02-01T00:00:00.000Z',
  closedAt: '2026-02-01T00:00:00.000Z',
  totalVotes: 10,
  turnoutPercent: 50,
  winners: [],
  ...over,
});

describe('HistoryPage', () => {
  it('lists past events with winners, joint winners and empty events', async () => {
    mockFetch({
      'GET /api/events/history': () => ({
        body: {
          events: [
            item({ eventId: 'e1', winners: [{ id: 'c1', name: 'Messi', team: '', votes: 6, percent: 60 }] }),
            item({
              eventId: 'e2',
              title: 'Goal of the Month',
              winners: [
                { id: 'a', name: 'Salah', team: '', votes: 5, percent: 50 },
                { id: 'b', name: 'Kane', team: '', votes: 5, percent: 50 },
              ],
            }),
            item({ eventId: 'e3', title: 'Quiet event', totalVotes: 0, turnoutPercent: 0 }),
          ],
        },
      }),
    });
    renderWithProviders(<App />, { route: '/history' });

    expect(await screen.findByText('Winner: Messi (60.0%)')).toBeInTheDocument();
    expect(screen.getByText('Joint winners: Salah (50.0%), Kane (50.0%)')).toBeInTheDocument();
    expect(screen.getByText('No votes were cast.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Goal of the Month/ })).toHaveAttribute('href', '/events/e2');
  });

  it('says so when nothing has finished yet', async () => {
    mockFetch({ 'GET /api/events/history': () => ({ body: { events: [] } }) });
    renderWithProviders(<App />, { route: '/history' });
    expect(await screen.findByText('No events have finished yet.')).toBeInTheDocument();
  });
});
