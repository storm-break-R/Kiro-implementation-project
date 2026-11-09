import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from '../api/client';
import App from '../App';
import { mockFetch, renderWithProviders } from '../test/utils';
import { validateRegistration } from './RegisterPage';

afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.clear();
});

const valid = {
  nationalId: 'AB1001',
  code: 'K7QM2-XR4TN-8PWD3',
  email: 'alice@example.com',
  password: 'a-strong-password',
  confirm: 'a-strong-password',
};

describe('validateRegistration', () => {
  it('accepts a complete form', () => expect(validateRegistration(valid)).toEqual({}));
  it('catches weak, mismatched and email-equal passwords', () => {
    expect(validateRegistration({ ...valid, password: 'short', confirm: 'short' }).password).toBeTruthy();
    expect(validateRegistration({ ...valid, confirm: 'different-password' }).confirm).toBeTruthy();
    expect(
      validateRegistration({ ...valid, email: 'someone@example.com', password: 'SOMEONE@example.com', confirm: 'SOMEONE@example.com' }).password,
    ).toMatch(/email/);
  });
  it('catches missing ID and short codes', () => {
    const e = validateRegistration({ ...valid, nationalId: '', code: 'ABC' });
    expect(e.nationalId).toBeTruthy();
    expect(e.code).toBeTruthy();
  });
});

async function fill(user: ReturnType<typeof userEvent.setup>, v = valid) {
  await user.type(screen.getByLabelText(/national id/i), v.nationalId);
  await user.type(screen.getByLabelText(/verification code/i), v.code);
  await user.type(screen.getByLabelText(/^email/i), v.email);
  await user.type(screen.getByLabelText(/^password/i), v.password);
  await user.type(screen.getByLabelText(/confirm password/i), v.confirm);
}

describe('RegisterPage', () => {
  it('does not call the API when the form is invalid', async () => {
    const { fn } = mockFetch({});
    const user = userEvent.setup();
    renderWithProviders(<App />, { route: '/register' });
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Enter your national ID')).toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
  });

  it('registers and lands on the voter dashboard', async () => {
    const { calls } = mockFetch({
      'POST /api/auth/register': () => ({
        status: 201,
        body: {
          accessToken: 'a',
          refreshToken: 'r'.repeat(30),
          user: { id: 'u1', email: 'alice@example.com', role: 'voter', mfaEnabled: false },
          mfaEnrollmentRequired: false,
        },
      }),
      'GET /api/voter/events': () => ({
        body: {
          events: [
            {
              id: 'e1',
              title: 'Player of the Season',
              status: 'open',
              votingOpen: true,
              hasVoted: false,
              startsAt: '2029-01-01T00:00:00.000Z',
              endsAt: '2030-01-01T00:00:00.000Z',
            },
          ],
        },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<App />, { route: '/register' });
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Your ballots' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Vote now' })).toHaveAttribute('href', '/events/e1');
    const body = JSON.parse(String(calls.find((c) => c.key === 'POST /api/auth/register')!.init!.body));
    expect(body).not.toHaveProperty('confirm');
    expect(body).toMatchObject({ nationalId: 'AB1001', email: 'alice@example.com' });
  });

  it('shows the server message (for example under 18)', async () => {
    mockFetch({
      'POST /api/auth/register': () => ({
        status: 403,
        body: { error: { code: 'UNDERAGE', message: 'You must be at least 18 years old to register to vote.' } },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<App />, { route: '/register' });
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 18/);
  });
});
