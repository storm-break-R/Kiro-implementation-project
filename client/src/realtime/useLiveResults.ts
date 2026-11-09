import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ResultsSnapshot } from '../api/types';
import { createSocket } from './socket';

export type ConnectionStatus = 'connecting' | 'live' | 'offline';

/** While the socket is down, fall back to polling at this interval. */
export const POLL_INTERVAL_MS = 10_000;

const newer = (a: ResultsSnapshot | null, b: ResultsSnapshot) =>
  !a || a.eventId !== b.eventId || b.updatedAt >= a.updatedAt ? b : a;

/**
 * Live results for one event: loads a REST snapshot, then follows socket.io updates. Resyncs on
 * reconnect and polls while disconnected, so the page stays current without a refresh.
 */
export function useLiveResults(eventId: string | undefined) {
  const [snapshot, setSnapshot] = useState<ResultsSnapshot | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);

  const load = useCallback(async () => {
    if (!eventId) return;
    try {
      const snap = await api<ResultsSnapshot>(`/api/events/${eventId}/results`, { auth: false });
      if (active.current) {
        setSnapshot((prev) => newer(prev, snap));
        setError(null);
      }
    } catch (e) {
      if (active.current) setError(e instanceof Error ? e.message : 'Could not load results');
    }
  }, [eventId]);

  useEffect(() => {
    if (!eventId) return undefined;
    active.current = true;
    setSnapshot(null);
    void load();

    const socket = createSocket();
    socket.on('connect', () => {
      setStatus('live');
      // Subscribing also returns a fresh snapshot, which covers anything missed while offline.
      socket.emit('results:subscribe', eventId);
    });
    socket.on('disconnect', () => setStatus('offline'));
    socket.on('connect_error', () => setStatus('offline'));
    socket.on('results:update', (snap: ResultsSnapshot) => {
      if (snap.eventId === eventId) setSnapshot((prev) => newer(prev, snap));
    });

    const poll = setInterval(() => {
      if (!socket.connected) void load();
    }, POLL_INTERVAL_MS);

    return () => {
      active.current = false;
      clearInterval(poll);
      socket.emit('results:unsubscribe', eventId);
      socket.disconnect();
    };
  }, [eventId, load]);

  return { snapshot, status, error, refresh: load };
}
