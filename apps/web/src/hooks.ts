import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

/**
 * Loads `GET path` and exposes a reload function. Only the latest request's answer is
 * used (a slow, older response never overwrites a newer one), and the data is cleared when
 * the path changes so one resource's data is never shown for another.
 */
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const request = ++latest.current;
    if (!path) return;
    setLoading(true);
    try {
      const result = await api<T>('GET', path);
      if (request !== latest.current) return;
      setData(result);
      setError(undefined);
    } catch (err) {
      if (request !== latest.current) return;
      setError(err instanceof ApiError ? err : new ApiError(0, 'network', 'Could not reach the server'));
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    // A new path: forget the previous resource before loading this one.
    setData(undefined);
    setError(undefined);
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
