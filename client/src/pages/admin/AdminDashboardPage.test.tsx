import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../../test/utils';
import AdminDashboardPage, { type Dashboard } from './AdminDashboardPage';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const base = {
  description: '',
  resultsVisibility: 'live' as const,
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2030-01-01T00:00:00.000Z',
  openedAt: null,
  closedAt: null,
};

function dashboard(status: 'open' | 'closed', voted: number): Dashboard {
  return {
    totals: { events: 2, open: status === 'open' ? 1 : 0, eligible: 10, registered: 8, voted },
    events: [
      {
        ...base,
        id: 'e1',
        title: 'Player of the Season',
        status,
        votingOpen: status === 'open',
        turnout: { eligible: 10, registered: 8, voted, remaining: 8 - voted, percent: voted * 10 },
      },
      {
        ...base,
        id: 'e2',
        title: 'Goal of the Month',
        status: 'draft',
        votingOpen: false,
        turnout: { eligible: 0, registered: 0, voted: 0, remaining: 0, percent: 0 },
      },
    ],
  };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <AdminDashboardPage />
    </MemoryRouter>,
  );

describe('AdminDashboardPage', () => {
  it('shows totals and per-event turnout with the right quick actions', async () => {
    mockFetch({ 'GET /api/admin/dashboard': () => ({ body: dashboard('open', 3) }) });
    renderPage();

    const totals = await screen.findByRole('region', { name: 'Totals' });
    expect(within(totals).getByText('Votes cast').previousSibling).toHaveTextContent('3');

    const open = screen.getByRole('article', { name: 'Player of the Season' });
    expect(within(open).getByText(/3 voted · 5 registered but not voted · 10 eligible/)).toBeInTheDocument();
    expect(within(open).getByRole('progressbar', { name: 'Turnout 30.0%' })).toBeInTheDocument();
    expect(within(open).getByRole('button', { name: 'Close voting' })).toBeInTheDocument();

    const draft = screen.getByRole('article', { name: 'Goal of the Month' });
    expect(within(draft).getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(within(draft).queryByRole('link', { name: 'Public results' })).not.toBeInTheDocument();
  });

  it('closes an event after confirmation and refreshes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { calls } = mockFetch({
      'GET /api/admin/dashboard': [() => ({ body: dashboard('open', 3) }), () => ({ body: dashboard('closed', 3) })],
      'POST /api/admin/events/e1/close': () => ({ body: { ...base, id: 'e1', status: 'closed' } }),
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Close voting' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close voting' })).not.toBeInTheDocument());
    expect(calls.some((c) => c.key === 'POST /api/admin/events/e1/close')).toBe(true);
  });

  it('does nothing when the confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { calls } = mockFetch({ 'GET /api/admin/dashboard': () => ({ body: dashboard('open', 3) }) });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Close voting' }));
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false);
  });
});
