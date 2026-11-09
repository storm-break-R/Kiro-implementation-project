import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from '../api/client';
import App from '../App';
import { mockFetch, renderWithProviders } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.clear();
});

const adminAuth = {
  accessToken: 'a',
  refreshToken: 'r'.repeat(30),
  user: { id: 'u1', email: 'admin@example.com', role: 'admin', mfaEnabled: true },
  mfaEnrollmentRequired: false,
};

describe('LoginPage', () => {
  it('asks for the authentication code after the password, then signs the admin in', async () => {
    const { calls } = mockFetch({
      'POST /api/auth/login': [
        () => ({ status: 401, body: { error: { code: 'MFA_REQUIRED', message: 'Authentication code required' } } }),
        () => ({ body: adminAuth }),
      ],
      'GET /api/admin/dashboard': () => ({
        body: { totals: { events: 0, open: 0, eligible: 0, registered: 0, voted: 0 }, events: [] },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<App />, { route: '/login' });

    await user.type(screen.getByLabelText(/email/i), 'admin@example.com');
    await user.type(screen.getByLabelText(/password/i), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const code = await screen.findByLabelText(/authentication code/i);
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: /verify and sign in/i }));

    expect(await screen.findByRole('heading', { name: 'Admin dashboard' })).toBeInTheDocument();
    const loginBodies = calls
      .filter((c) => c.key === 'POST /api/auth/login')
      .map((c) => JSON.parse(String(c.init?.body)));
    expect(loginBodies[0]).toEqual({ email: 'admin@example.com', password: 'correct-horse-battery' });
    expect(loginBodies[1]).toMatchObject({ totpCode: '123456' });
  });

  it('shows an error for bad credentials and stays on the form', async () => {
    mockFetch({
      'POST /api/auth/login': () => ({
        status: 401,
        body: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<App />, { route: '/login' });

    await user.type(screen.getByLabelText(/email/i), 'a@b.co');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(screen.queryByLabelText(/authentication code/i)).not.toBeInTheDocument();
  });

  it('sends an admin who has not enrolled to the MFA setup page', async () => {
    mockFetch({
      'POST /api/auth/login': () => ({
        body: { ...adminAuth, user: { ...adminAuth.user, mfaEnabled: false }, mfaEnrollmentRequired: true },
      }),
      'POST /api/auth/mfa/setup': () => ({
        body: { secret: 'ABCDEF', otpauthUrl: 'otpauth://x', qrDataUrl: 'data:image/png;base64,AAAA' },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<App />, { route: '/login' });

    await user.type(screen.getByLabelText(/email/i), 'admin@example.com');
    await user.type(screen.getByLabelText(/password/i), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: /two-factor/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByAltText(/qr code/i)).toBeInTheDocument());
  });
});
