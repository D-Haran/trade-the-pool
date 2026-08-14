'use client';

import { LogIn, LogOut, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { clearSessionScopedQueries } from '@/lib/session-cache';
import { realtimeClient } from '@/lib/realtime-client';
import { isSessionCheckUnavailable } from '@/lib/session-state';

export function SessionControl() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: queryKeys.session, queryFn: api.session, retry: false });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      realtimeClient.authenticationChanged(false);
      clearSessionScopedQueries(queryClient);
      queryClient.setQueryData(queryKeys.session, null);
      router.push('/');
    },
  });
  if (session.isLoading)
    return <span className="session-placeholder" aria-label="Restoring session" />;
  if (isSessionCheckUnavailable(session.isError, session.data))
    return (
      <button
        className="session-link"
        onClick={() => session.refetch()}
        aria-label="Retry session check"
      >
        Session unavailable
      </button>
    );
  if (!session.data)
    return (
      <Link className="session-link" href={`/login?returnTo=${encodeURIComponent(pathname)}`}>
        <LogIn aria-hidden="true" /> <span>Sign in</span>
      </Link>
    );
  return (
    <div className="session-user">
      <UserRound aria-hidden="true" />
      <Link href="/account" aria-label="Open account wallet settings">
        {session.data.displayName}
      </Link>
      <button onClick={() => logout.mutate()} disabled={logout.isPending} aria-label="Sign out">
        <LogOut aria-hidden="true" />
      </button>
    </div>
  );
}
