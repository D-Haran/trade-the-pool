'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

function countdownLabel(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  return days ? `${days}d ${clock}` : clock;
}

export function Countdown({
  endsAt,
  prefix,
  onExpire,
}: {
  endsAt: string | null;
  prefix?: string;
  onExpire?: () => void;
}) {
  const target = useMemo(() => (endsAt ? new Date(endsAt).getTime() : null), [endsAt]);
  const [now, setNow] = useState(Date.now());
  const expired = useRef(false);
  useEffect(() => {
    if (target === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [target]);
  useEffect(() => {
    if (target !== null && now >= target && !expired.current) {
      expired.current = true;
      onExpire?.();
    }
  }, [now, onExpire, target]);
  if (target === null) return <span>Not scheduled</span>;
  return (
    <span className="tabular">
      {prefix ? `${prefix} ` : ''}
      {countdownLabel(target - now)}
    </span>
  );
}
