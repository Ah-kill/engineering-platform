import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** Loads `GET path` and exposes a reload function. */
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>('GET', path));
      setError(undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'network', 'Could not reach the server'));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

/** Wraps an async action with pending and error state for forms and buttons. */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = async (...args: A): Promise<boolean> => {
    setPending(true);
    setError(undefined);
    try {
      await fn(...args);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      return false;
    } finally {
      setPending(false);
    }
  };
  return { run, pending, error, clearError: () => setError(undefined) };
}
