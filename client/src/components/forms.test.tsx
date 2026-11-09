import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CandidateForm, { MAX_IMAGE_BYTES, validateCandidate } from './CandidateForm';
import EventForm, { validateEvent, type EventFormValues } from './EventForm';

const valid: EventFormValues = {
  title: 'Player of the Season',
  description: '',
  startsAt: '2030-01-01T10:00',
  endsAt: '2030-01-02T10:00',
  resultsVisibility: 'live',
};

describe('validateEvent', () => {
  it('accepts valid values', () => {
    expect(validateEvent(valid)).toEqual({});
  });
  it('flags a short title and an end before the start', () => {
    const errors = validateEvent({ ...valid, title: 'ab', endsAt: '2029-12-31T10:00' });
    expect(errors.title).toBeTruthy();
    expect(errors.endsAt).toBeTruthy();
  });
});

describe('EventForm', () => {
  it('shows errors and does not submit invalid input', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<EventForm initial={{ ...valid, title: '' }} submitLabel="Create" onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText(/at least 3 characters/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits valid values', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<EventForm initial={valid} submitLabel="Create" onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(valid));
  });
});

describe('validateCandidate', () => {
  const file = (type: string, size = 10) => new File([new Uint8Array(size)], 'x', { type });
  it('requires a name', () => expect(validateCandidate(' ', null)).toMatch(/name/i));
  it('accepts a name without an image', () => expect(validateCandidate('Messi', null)).toBeNull());
  it('rejects non-image types', () => expect(validateCandidate('A', file('text/html'))).toMatch(/JPEG/));
  it('rejects oversized images', () =>
    expect(validateCandidate('A', file('image/png', MAX_IMAGE_BYTES + 1))).toMatch(/2 MB/));
});

describe('CandidateForm', () => {
  it('submits multipart data including the image', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<CandidateForm submitLabel="Add" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText(/^name/i), 'Messi');
    await user.upload(screen.getByLabelText(/photo/i), new File(['x'], 'm.png', { type: 'image/png' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const data = onSubmit.mock.calls[0]![0] as FormData;
    expect(data.get('name')).toBe('Messi');
    expect((data.get('image') as File).name).toBe('m.png');
  });

  it('blocks an oversized image with a message', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<CandidateForm submitLabel="Add" onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText(/^name/i), 'Messi');
    const big = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'big.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText(/photo/i), big);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/2 MB/);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
