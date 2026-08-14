import { CloudOff, Radio } from 'lucide-react';
import type { ConnectionState } from '@/lib/realtime-client';

export function ConnectionStatus({ state }: { state: ConnectionState }) {
  const live = state === 'CONNECTED';
  return (
    <span className={`connection-status connection-status--${state.toLowerCase()}`} role="status">
      {live ? <Radio aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
      {live
        ? 'Live'
        : state === 'RECONNECTING'
          ? 'Reconnecting'
          : state === 'CONNECTING'
            ? 'Connecting'
            : 'Offline'}
    </span>
  );
}
