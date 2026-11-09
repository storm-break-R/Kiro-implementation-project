import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, tokenStore } from '../api/client';
import type { AuthResponse, User } from '../api/types';

interface AuthState {
  user: User | null;
  /** True until the initial session restore finishes. */
  loading: boolean;
  /** Admin has signed in but still has to enroll TOTP. */
  mfaEnrollmentRequired: boolean;
  login(input: { email: string; password: string; totpCode?: string }): Promise<AuthResponse>;
  applyAuth(res: AuthResponse): void;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [mfaEnrollmentRequired, setMfaEnrollmentRequired] = useState(false);
  const [loading, setLoading] = useState(true);

  const applyAuth = useCallback((res: AuthResponse) => {
    tokenStore.set(res.accessToken, res.refreshToken);
    setUser(res.user);
    setMfaEnrollmentRequired(res.mfaEnrollmentRequired);
  }, []);

  const clear = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setMfaEnrollmentRequired(false);
  }, []);

  // Restore the session after a page reload using the stored refresh token.
  useEffect(() => {
    tokenStore.setExpiredHandler(clear);
    const refreshToken = tokenStore.getRefresh();
    if (!refreshToken) {
      setLoading(false);
      return () => tokenStore.setExpiredHandler(null);
    }
    let cancelled = false;
    api<AuthResponse>('/api/auth/refresh', { method: 'POST', body: { refreshToken }, auth: false })
      .then((res) => {
        if (!cancelled) applyAuth(res);
      })
      .catch(() => {
        if (!cancelled) clear();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      tokenStore.setExpiredHandler(null);
    };
  }, [applyAuth, clear]);

  const login = useCallback<AuthState['login']>(
    async (input) => {
      const res = await api<AuthResponse>('/api/auth/login', { method: 'POST', body: input, auth: false });
      applyAuth(res);
      return res;
    },
    [applyAuth],
  );

  const logout = useCallback(async () => {
    const refreshToken = tokenStore.getRefresh();
    clear();
    if (refreshToken) {
      await api('/api/auth/logout', { method: 'POST', body: { refreshToken }, auth: false }).catch(() => undefined);
    }
  }, [clear]);

  const value = useMemo(
    () => ({ user, loading, mfaEnrollmentRequired, login, applyAuth, logout }),
    [user, loading, mfaEnrollmentRequired, login, applyAuth, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
