import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useState, type FormEvent } from 'react';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await login({ email, password, ...(needsTotp ? { totpCode } : {}) });
      if (res.user.role === 'admin') {
        navigate(res.mfaEnrollmentRequired ? '/admin/mfa' : '/admin', { replace: true });
      } else {
        navigate(from ?? '/dashboard', { replace: true });
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_REQUIRED') {
        setNeedsTotp(true);
      } else if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS' && needsTotp) {
        setError('Invalid email, password or authentication code.');
      } else {
        setError(err instanceof Error ? err.message : 'Sign in failed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Paper component="form" onSubmit={onSubmit} sx={{ maxWidth: 440, mx: 'auto', p: 4 }} aria-labelledby="login-title">
      <Stack spacing={2.5}>
        <Typography id="login-title" variant="h4" component="h1">
          Sign in
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={needsTotp}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={needsTotp}
        />
        {needsTotp && (
          <TextField
            label="Authentication code"
            helperText="Enter the 6-digit code from your authenticator app"
            autoComplete="one-time-code"
            required
            autoFocus
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            slotProps={{ htmlInput: { inputMode: 'numeric', pattern: '\\d{6}' } }}
          />
        )}
        <Button type="submit" variant="contained" size="large" disabled={busy}>
          {needsTotp ? 'Verify and sign in' : 'Sign in'}
        </Button>
        <Box sx={{ textAlign: 'center' }}>
          <Typography variant="body2">
            Have a voter code? <RouterLink to="/register">Register to vote</RouterLink>
          </Typography>
        </Box>
      </Stack>
    </Paper>
  );
}
