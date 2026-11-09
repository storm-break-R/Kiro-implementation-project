import { Alert, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AuthResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';

interface Setup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

/** Admins must enroll an authenticator app before they can use any admin feature. */
export default function MfaSetupPage() {
  const { applyAuth } = useAuth();
  const navigate = useNavigate();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<Setup>('/api/auth/mfa/setup', { method: 'POST' })
      .then((s) => !cancelled && setSetup(s))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'Could not start setup'));
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<AuthResponse>('/api/auth/mfa/verify', { method: 'POST', body: { code } });
      applyAuth(res);
      navigate('/admin', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Paper component="form" onSubmit={onSubmit} sx={{ maxWidth: 480, mx: 'auto', p: 4 }}>
      <Stack spacing={2.5}>
        <Typography variant="h4" component="h1">
          Set up two-factor authentication
        </Typography>
        <Typography color="text.secondary">
          Scan this QR code with an authenticator app (Google Authenticator, Authy, 1Password), then enter the
          6-digit code it shows.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {setup && (
          <>
            <img
              src={setup.qrDataUrl}
              alt="QR code for your authenticator app"
              width={220}
              height={220}
              style={{ alignSelf: 'center' }}
            />
            <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
              Can&apos;t scan? Enter this key manually: <code>{setup.secret}</code>
            </Typography>
          </>
        )}
        <TextField
          label="Authentication code"
          required
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          slotProps={{ htmlInput: { inputMode: 'numeric', pattern: '\\d{6}' } }}
        />
        <Button type="submit" variant="contained" size="large" disabled={busy || !setup || code.length !== 6}>
          Enable two-factor authentication
        </Button>
      </Stack>
    </Paper>
  );
}
