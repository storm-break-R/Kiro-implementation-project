import { screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { mockFetch, renderWithProviders } from './test/utils';

vi.mock('react-chartjs-2', () => ({ Line: () => null, Bar: () => null }));
vi.mock('./realtime/socket', () => ({
  createSocket: () => ({ connected: false, on() {}, off() {}, emit() {}, disconnect() {} }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

/** Automated checks only: they catch missing names, labels, roles and structure, not everything. */
async function expectNoViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    // jsdom has no layout engine, so contrast can't be measured here.
    rules: { 'color-contrast': { enabled: false } },
  });
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(summary).toEqual([]);
}

const event = {
  id: 'e1',
  title: 'Player of the Season',
  description: 'Vote for the best player.',
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

const results = {
  eventId: 'e1',
  title: event.title,
  status: 'open',
  votingOpen: true,
  endsAt: event.endsAt,
  resultsVisible: true,
  final: false,
  totalVotes: 3,
  turnout: { eligible: 10, registered: 5, voted: 3, percent: 30 },
  candidates: [
    { id: 'c1', name: 'Messi', team: 'Inter Miami', imageUrl: null, votes: 2, percent: 66.7 },
    { id: 'c2', name: 'Ronaldo', team: 'Al Nassr', imageUrl: null, votes: 1, percent: 33.3 },
  ],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('accessibility (axe)', () => {
  it('control: the harness does flag broken markup', async () => {
    const div = document.createElement('div');
    div.innerHTML = '<img src="x.png"><button></button><input type="text">';
    document.body.appendChild(div);
    const res = await axe.run(div, { rules: { 'color-contrast': { enabled: false } } });
    expect(res.violations.map((v) => v.id)).toEqual(expect.arrayContaining(['image-alt', 'button-name', 'label']));
    div.remove();
  });

  it('home page', async () => {
    mockFetch({ 'GET /api/events': () => ({ body: { events: [event] } }) });
    const { container } = renderWithProviders(<App />);
    await screen.findByRole('heading', { name: 'Player of the Season' });
    await expectNoViolations(container);
  });

  it('sign in page', async () => {
    mockFetch({});
    const { container } = renderWithProviders(<App />, { route: '/login' });
    await screen.findByRole('heading', { name: 'Sign in' });
    await expectNoViolations(container);
  });

  it('registration page', async () => {
    mockFetch({});
    const { container } = renderWithProviders(<App />, { route: '/register' });
    await screen.findByRole('heading', { name: 'Register to vote' });
    await expectNoViolations(container);
  });

  it('live results page with statistics', async () => {
    mockFetch({
      'GET /api/events/e1': () => ({ body: event }),
      'GET /api/events/e1/results': () => ({ body: results }),
      'GET /api/events/e1/timeline': () => ({
        body: { points: [{ bucket: '2026-01-01T10:00:00.000Z', votes: 3, cumulative: 3 }] },
      }),
    });
    const { container } = renderWithProviders(<App />, { route: '/events/e1' });
    await screen.findByRole('table', { name: 'Vote share' });
    await expectNoViolations(container);
  });

  it('history page', async () => {
    mockFetch({
      'GET /api/events/history': () => ({
        body: {
          events: [
            {
              eventId: 'e1',
              title: 'Player of the Season',
              startsAt: event.startsAt,
              endsAt: event.endsAt,
              closedAt: event.endsAt,
              totalVotes: 3,
              turnoutPercent: 30,
              winners: [{ id: 'c1', name: 'Messi', team: '', votes: 2, percent: 66.7 }],
            },
          ],
        },
      }),
    });
    const { container } = renderWithProviders(<App />, { route: '/history' });
    await screen.findByText(/Winner: Messi/);
    await expectNoViolations(container);
  });
});
