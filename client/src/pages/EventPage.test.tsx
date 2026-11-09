import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from '../api/client';
import type { ResultsSnapshot } from '../api/types';
import App from '../App';
import { mockFetch, renderWithProviders } from '../test/utils';

type Handler = (...args: unknown[]) => void;

class FakeSocket {
  connected = false;
  emitted: unknown[][] = [];
  private handlers = new Map<string, Handler[]>();
  on(event: string, fn: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  off() {
    return this;
  }
  emit(...args: unknown[]) {
    this.emitted.push(args);
    return this;
  }
  disconnect() {
    this.connected = false;
  }
  trigger(event: string, ...args: unknown[]) {
    if (event === 'connect') this.connected = true;
    if (event === 'disconnect') this.connected = false;
    this.handlers.get(event)?.forEach((fn) => fn(...args));
  }
}

const sockets = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../realtime/socket', () => ({ createSocket: () => sockets.current }));
// jsdom has no canvas; charts are covered by their aria-labels and tables.
vi.mock('react-chartjs-2', () => ({ Line: () => null, Bar: () => null }));

let socket: FakeSocket;
beforeEach(() => {
  socket = new FakeSocket();
  sockets.current = socket;
});
afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.clear();
  sessionStorage.clear();
});

const event = {
  id: 'e1',
  title: 'Player of the Season',
  description: '',
  status: 'open',
  votingOpen: true,
  resultsVisibility: 'live',
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2030-01-01T00:00:00.000Z',
  openedAt: null,
  closedAt: null,
  candidates: [
    { id: 'c1', eventId: 'e1', name: 'Messi', team: 'Inter Miami', bio: '', imageUrl: null },
    { id: 'c2', eventId: 'e1', name: 'Ronaldo', team: 'Al Nassr', bio: '', imageUrl: null },
  ],
};

function snapshot(messi: number, ronaldo: number, over: Partial<ResultsSnapshot> = {}): ResultsSnapshot {
  const total = messi + ronaldo;
  const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    eventId: 'e1',
    title: event.title,
    status: 'open',
    votingOpen: true,
    endsAt: event.endsAt,
    resultsVisible: true,
    final: false,
    totalVotes: total,
    turnout: { eligible: 10, registered: 8, voted: total, percent: total * 10 },
    candidates: [
      { id: 'c1', name: 'Messi', team: 'Inter Miami', imageUrl: null, votes: messi, percent: pct(messi) },
      { id: 'c2', name: 'Ronaldo', team: 'Al Nassr', imageUrl: null, votes: ronaldo, percent: pct(ronaldo) },
    ],
    updatedAt: new Date(Date.now() + total).toISOString(),
    ...over,
  };
}

describe('EventPage live results', () => {
  it('shows the REST snapshot, subscribes, and applies socket updates without a refresh', async () => {
    mockFetch({
      'GET /api/events/e1': () => ({ body: event }),
      'GET /api/events/e1/results': () => ({ body: snapshot(3, 1) }),
    });
    renderWithProviders(<App />, { route: '/events/e1' });

    expect(await screen.findByText('4 votes · turnout 40.0%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Messi: 75.0% of votes' })).toBeInTheDocument();

    act(() => socket.trigger('connect'));
    expect(socket.emitted).toContainEqual(['results:subscribe', 'e1']);
    expect(await screen.findByText('Live')).toBeInTheDocument();

    act(() => socket.trigger('results:update', snapshot(3, 5)));
    expect(await screen.findByText('8 votes · turnout 80.0%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Ronaldo: 62.5% of votes' })).toBeInTheDocument();

    // Leader is listed first.
    const items = within(screen.getByRole('region', { name: 'Results' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Ronaldo');
  });

  it('ignores stale or foreign updates', async () => {
    mockFetch({
      'GET /api/events/e1': () => ({ body: event }),
      'GET /api/events/e1/results': () => ({ body: snapshot(3, 1) }),
    });
    renderWithProviders(<App />, { route: '/events/e1' });
    await screen.findByText('4 votes · turnout 40.0%');
    act(() => socket.trigger('results:update', { ...snapshot(9, 9), eventId: 'other' }));
    act(() => socket.trigger('results:update', { ...snapshot(0, 0), updatedAt: '2000-01-01T00:00:00.000Z' }));
    expect(screen.getByText('4 votes · turnout 40.0%')).toBeInTheDocument();
  });

  it('shows hidden results without per-candidate numbers', async () => {
    mockFetch({
      'GET /api/events/e1': () => ({ body: event }),
      'GET /api/events/e1/results': () => ({
        body: {
          ...snapshot(0, 0),
          totalVotes: 2,
          resultsVisible: false,
          candidates: snapshot(0, 0).candidates.map((c) => ({ ...c, votes: null, percent: null })),
        },
      }),
    });
    renderWithProviders(<App />, { route: '/events/e1' });
    expect(await screen.findByText(/hidden until voting closes/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('tells the viewer when the live connection drops', async () => {
    mockFetch({
      'GET /api/events/e1': () => ({ body: event }),
      'GET /api/events/e1/results': () => ({ body: snapshot(1, 1) }),
    });
    renderWithProviders(<App />, { route: '/events/e1' });
    await screen.findByText('2 votes · turnout 20.0%');
    act(() => socket.trigger('connect'));
    act(() => socket.trigger('disconnect'));
    expect(await screen.findByText(/reconnecting/i)).toBeInTheDocument();
  });
});

describe('EventPage voting', () => {
  function asVoter(hasVoted: boolean) {
    sessionStorage.setItem('sv.refresh', 'r'.repeat(30));
    return mockFetch({
      'POST /api/auth/refresh': () => ({
        body: {
          accessToken: 'a',
          refreshToken: 's'.repeat(30),
          user: { id: 'u1', email: 'v@example.com', role: 'voter', mfaEnabled: false },
          mfaEnrollmentRequired: false,
        },
      }),
      'GET /api/events/e1': () => ({ body: event }),
      'GET /api/events/e1/results': () => ({ body: snapshot(0, 0) }),
      'GET /api/voter/events': () => ({ body: { events: [{ ...event, hasVoted }] } }),
      'POST /api/voter/events/e1/vote': () => ({ status: 201, body: { ok: true } }),
    });
  }

  it('confirms, submits once, and then hides the ballot', async () => {
    const { calls } = asVoter(false);
    const user = userEvent.setup();
    renderWithProviders(<App />, { route: '/events/e1' });

    await user.click(await screen.findByRole('button', { name: 'Vote for Messi' }));
    const dialog = await screen.findByRole('dialog', { name: 'Vote for Messi?' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm vote' }));

    expect(await screen.findByText(/your vote has been counted/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /vote for/i })).not.toBeInTheDocument());
    const votes = calls.filter((c) => c.key === 'POST /api/voter/events/e1/vote');
    expect(votes).toHaveLength(1);
    expect(JSON.parse(String(votes[0]!.init!.body))).toEqual({ candidateId: 'c1' });
  });

  it('cancelling the confirmation does not vote', async () => {
    const { calls } = asVoter(false);
    const user = userEvent.setup();
    renderWithProviders(<App />, { route: '/events/e1' });
    await user.click(await screen.findByRole('button', { name: 'Vote for Ronaldo' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.key === 'POST /api/voter/events/e1/vote')).toBe(false);
  });

  it('shows no ballot to a voter who already voted', async () => {
    asVoter(true);
    renderWithProviders(<App />, { route: '/events/e1' });
    expect(await screen.findByText(/already voted/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /vote for/i })).not.toBeInTheDocument();
  });

  it('invites anonymous visitors to sign in instead of showing a ballot', async () => {
    mockFetch({
      'GET /api/events/e1': () => ({ body: event }),
      'GET /api/events/e1/results': () => ({ body: snapshot(0, 0) }),
    });
    renderWithProviders(<App />, { route: '/events/e1' });
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /vote for/i })).not.toBeInTheDocument();
  });
});
