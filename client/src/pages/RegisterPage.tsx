import { Alert, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useState, type FormEvent } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AuthResponse } from '../api/types';
import { useAuth } from '../auth/AuthContext';

export interface RegisterValues {
  nationalId: string;
  code: string;
  email: string;
  password: string;
  confirm: string;
}

export function validateRegistration(v: RegisterValues): Partial<Record<keyof RegisterValues, string>> {
  const e: Partial<Record<keyof RegisterValues, string>> = {};
  if (v.nationalId.trim().length < 4) e.nationalId = 'Enter your national ID';
  if (v.code.replace(/[\s-]/g, '').length < 10) e.code = 'Enter the verification code you were given';
  if (!/^\S+@\S+\.\S+$/.test(v.email)) e.email = 'Enter a valid email address';
  if (v.password.length < 10) e.password = 'Use at least 10 characters';
  else if (v.password.toLowerCase() === v.email.toLowerCase()) e.password = 'Password must not be your email';
  if (v.confirm !== v.password) e.confirm = 'Passwords do not match';
  return e;
}

export default function RegisterPage() {
  const { applyAuth } = useAuth();
  const navigate = useNavigate();
  const [values, setValues] = useState<RegisterValues>({ nationalId: '', code: '', email: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<ReturnType<typeof validateRegistration>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof RegisterValues) => (e: { target: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);
    const found = validateRegistration(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      const { nationalId, code, email, password } = values;
      const res = await api<AuthResponse>('/api/auth/register', {
        method: 'POST',
        body: { nationalId, code, email, password },
        auth: false,
      });
      applyAuth(res);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Paper component="form" onSubmit={onSubmit} noValidate sx={{ maxWidth: 520, mx: 'auto', p: 4 }}>
      <Stack spacing={2.5}>
        <Typography variant="h4" component="h1">
          Register to vote
        </Typography>
        <Typography color="text.secondary">
          You need to be 18 or older and on the voter list. Use the verification code the organizer gave you. Each code
          works once.
        </Typography>
        {serverError && <Alert severity="error">{serverError}</Alert>}
        <TextField
          label="National ID"
          required
          value={values.nationalId}
          onChange={set('nationalId')}
          error={!!errors.nationalId}
          helperText={errors.nationalId}
          autoComplete="off"
        />
        <TextField
          label="Verification code"
          required
          value={values.code}
          onChange={set('code')}
          error={!!errors.code}
          helperText={errors.code ?? 'For example K7QM2-XR4TN-8PWD3'}
          autoComplete="off"
          slotProps={{ htmlInput: { style: { textTransform: 'uppercase' } } }}
        />
        <TextField
          label="Email"
          type="email"
          required
          value={values.email}
          onChange={set('email')}
          error={!!errors.email}
          helperText={errors.email}
          autoComplete="email"
        />
        <TextField
          label="Password"
          type="password"
          required
          value={values.password}
          onChange={set('password')}
          error={!!errors.password}
          helperText={errors.password ?? 'At least 10 characters'}
          autoComplete="new-password"
        />
        <TextField
          label="Confirm password"
          type="password"
          required
          value={values.confirm}
          onChange={set('confirm')}
          error={!!errors.confirm}
          helperText={errors.confirm}
          autoComplete="new-password"
        />
        <Button type="submit" variant="contained" size="large" disabled={busy}>
          Create account
        </Button>
        <Typography variant="body2" sx={{ textAlign: 'center' }}>
          Already registered? <RouterLink to="/login">Sign in</RouterLink>
        </Typography>
      </Stack>
    </Paper>
  );
}
