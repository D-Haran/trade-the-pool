'use client';

import type { RealtimeEvent } from '@trade-the-pool/shared';
import { useEffect, useRef, useState } from 'react';
import { realtimeClient, type ConnectionState } from '@/lib/realtime-client';

export function useRealtime(
  topics: string[],
  onEvent: (event: RealtimeEvent) => void,
  onResync?: () => void,
): ConnectionState {
  const [state, setState] = useState<ConnectionState>('DISCONNECTED');
  const eventRef = useRef(onEvent);
  const resyncRef = useRef(onResync);
  const previous = useRef<ConnectionState>('DISCONNECTED');
  eventRef.current = onEvent;
  resyncRef.current = onResync;

  useEffect(() => realtimeClient.onState(setState), []);
  useEffect(() => {
    const unsubscribe = topics.map((topic) =>
      realtimeClient.subscribe(topic, (event) => eventRef.current(event)),
    );
    return () => unsubscribe.forEach((remove) => remove());
  }, [topics.join('|')]);
  useEffect(() => {
    if (state === 'CONNECTED' && ['RECONNECTING', 'DISCONNECTED'].includes(previous.current))
      resyncRef.current?.();
    previous.current = state;
  }, [state]);
  return state;
}
