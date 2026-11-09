import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../../test/utils';
import VotersPanel from './VotersPanel';

afterEach(() => vi.unstubAllGlobals());

const list = (overrides: Record<string, unknown> = {}) => ({
  voters: [
    { id: 'v1', fullName: 'Alice Adams', email: 'alice@example.com', nationalIdLast4: '1001', registered: false, codeStatus: 'unused' },
    { id: 'v2', fullName: 'Bob Brown', email: '', nationalIdLast4: '1002', registered: true, codeStatus: 'used' },
  ],
  total: 2,
  page: 1,
  limit: 25,
  totals: { eligible: 2, registered: 1, codesIssued: 2 },
  ...overrides,
});

describe('VotersPanel', () => {
  it('shows totals and voter rows, offering code actions only for unregistered voters', async () => {
    mockFetch({ 'GET /api/admin/events/e1/voters?page=1&limit=25': () => ({ body: list() }) });
    render(<VotersPanel eventId="e1" locked={false} />);

    expect(await screen.findByText('Alice Adams')).toBeInTheDocument();
    expect(screen.getByText('2 eligible')).toBeInTheDocument();
    expect(screen.getByText('1 registered')).toBeInTheDocument();

    const aliceRow = screen.getByRole('row', { name: /alice adams/i });
    const bobRow = screen.getByRole('row', { name: /bob brown/i });
    expect(within(aliceRow).getByRole('button', { name: 'New code' })).toBeInTheDocument();
    expect(within(bobRow).queryByRole('button')).not.toBeInTheDocument();
  });

  it('reports row-level import errors', async () => {
    mockFetch({
      'GET /api/admin/events/e1/voters?page=1&limit=25': () => ({ body: list() }),
      'POST /api/admin/events/e1/voters/import': () => ({
        status: 201,
        body: {
          imported: 1,
          skipped: 2,
          under18: 1,
          errors: [
            { row: 3, message: 'dateOfBirth must be a real date in YYYY-MM-DD format' },
            { row: 5, message: 'duplicate national ID in this file' },
          ],
        },
      }),
    });
    const user = userEvent.setup();
    render(<VotersPanel eventId="e1" locked={false} />);
    await screen.findByText('Alice Adams');

    await user.upload(screen.getByLabelText(/csv file/i), new File(['name\nx'], 'voters.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: 'Import voters' }));

    expect(await screen.findByText(/Row 3: dateOfBirth must be a real date/)).toBeInTheDocument();
    expect(screen.getByText(/Row 5: duplicate national ID/)).toBeInTheDocument();
    expect(screen.getByText(/under 18/)).toBeInTheDocument();
  });

  it('shows a newly issued code once, in a dialog', async () => {
    mockFetch({
      'GET /api/admin/events/e1/voters?page=1&limit=25': () => ({ body: list() }),
      'POST /api/admin/events/e1/voters/v1/code': () => ({ body: { generated: 1, codes: [{ code: 'ABCDE-FGHJK-23456' }] } }),
    });
    const user = userEvent.setup();
    render(<VotersPanel eventId="e1" locked={false} />);
    await user.click(await screen.findByRole('button', { name: 'New code' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('issued-code')).toHaveTextContent('ABCDE-FGHJK-23456');
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('ABCDE-FGHJK-23456')).not.toBeInTheDocument());
  });

  it('hides editing controls once the event is closed', async () => {
    mockFetch({ 'GET /api/admin/events/e1/voters?page=1&limit=25': () => ({ body: list() }) });
    render(<VotersPanel eventId="e1" locked />);
    await screen.findByText('Alice Adams');
    expect(screen.queryByRole('button', { name: 'Import voters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New code' })).not.toBeInTheDocument();
  });
});
