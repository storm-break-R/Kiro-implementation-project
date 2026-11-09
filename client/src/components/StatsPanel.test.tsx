import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResultsSnapshot } from '../api/types';
import { mockFetch } from '../test/utils';
import StatsPanel from './StatsPanel';

vi.mock('react-chartjs-2', () => ({ Line: () => null, Bar: () => null }));
afterEach(() => vi.unstubAllGlobals());

const snap = (over: Partial<ResultsSnapshot> = {}): ResultsSnapshot => ({
  eventId: 'e1',
  title: 'Player of the Season',
  status: 'open',
  votingOpen: true,
  endsAt: '2030-01-01T00:00:00.000Z',
  resultsVisible: true,
  final: false,
  totalVotes: 4,
  turnout: { eligible: 10, registered: 6, voted: 4, percent: 40 },
  candidates: [
    { id: 'c1', name: 'Messi', team: '', imageUrl: null, votes: 3, percent: 75 },
    { id: 'c2', name: 'Ronaldo', team: '', imageUrl: null, votes: 1, percent: 25 },
  ],
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('StatsPanel', () => {
  it('shows turnout, the vote trend and a share table', async () => {
    mockFetch({
      'GET /api/events/e1/timeline': () => ({
        body: {
          points: [
            { bucket: '2026-01-01T10:00:00.000Z', votes: 3, cumulative: 3 },
            { bucket: '2026-01-01T10:05:00.000Z', votes: 1, cumulative: 4 },
          ],
        },
      }),
    });
    render(<StatsPanel snapshot={snap()} />);

    expect(screen.getByText('40.0%')).toBeInTheDocument();
    expect(screen.getByText(/4 of 10 eligible voters have voted \(6 registered\)/)).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /Cumulative votes .* reaching 4/ })).toBeInTheDocument();
    expect(screen.getByText('Busiest interval: 3 votes.', { exact: false })).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Vote share' });
    const messi = within(table).getByRole('row', { name: /Messi/ });
    expect(messi).toHaveTextContent('375.0%');
  });

  it('keeps candidate share hidden while results are hidden', async () => {
    mockFetch({ 'GET /api/events/e1/timeline': () => ({ body: { points: [] } }) });
    render(
      <StatsPanel
        snapshot={snap({ resultsVisible: false, candidates: snap().candidates.map((c) => ({ ...c, votes: null, percent: null })) })}
      />,
    );
    expect(screen.getByText('Shown when voting closes.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(await screen.findByText('No votes yet.')).toBeInTheDocument();
  });

  it('refetches the trend when the vote count changes', async () => {
    const { calls } = mockFetch({ 'GET /api/events/e1/timeline': () => ({ body: { points: [] } }) });
    const { rerender } = render(<StatsPanel snapshot={snap()} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    rerender(<StatsPanel snapshot={snap({ totalVotes: 5 })} />);
    await waitFor(() => expect(calls).toHaveLength(2), { timeout: 4000 });
  });
});
