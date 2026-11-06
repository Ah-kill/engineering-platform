import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type Me } from './api';

/** Signed in, or the password was right and a two-step code is needed for this challenge. */
export type LoginResult = { done: true } | { done: false; challenge: string };

interface AuthState {
  me: Me | null;
  loading: boolean;
  refresh(): Promise<void>;
  login(email: string, password: string): Promise<LoginResult>;
  /** Second step: a 6-digit authenticator code or a recovery code. */
  loginWithCode(challenge: string, code: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('GET', '/auth/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = async (email: string, password: string): Promise<LoginResult> => {
    const res = await api<{ ok?: true; mfaRequired?: true; challenge?: string }>('POST', '/auth/login', { email, password });
    if (res.mfaRequired && res.challenge) return { done: false, challenge: res.challenge };
    await refresh();
    return { done: true };
  };

  const loginWithCode = async (challenge: string, code: string) => {
    await api('POST', '/auth/login/mfa', { challenge, code });
    await refresh();
  };

  const logout = async () => {
    await api('POST', '/auth/logout').catch(() => undefined);
    setMe(null);
  };

  return <AuthContext.Provider value={{ me, loading, refresh, login, loginWithCode, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
