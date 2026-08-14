'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { isSessionCheckUnavailable, shouldRedirectToLogin } from '@/lib/session-state';
import { ErrorState, LoadingState } from './ui/states';

export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useQuery({ queryKey: queryKeys.session, queryFn: api.session, retry: false });
  useEffect(() => {
    if (shouldRedirectToLogin(session.isSuccess, session.data))
      router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`);
  }, [pathname, router, session.data, session.isSuccess]);
  if (session.isLoading) return <LoadingState label="Restoring your session" />;
  if (isSessionCheckUnavailable(session.isError, session.data))
    return (
      <ErrorState
        title="Session check unavailable"
        detail="Your session has not been cleared. Reconnect and try again."
        retry={() => session.refetch()}
      />
    );
  if (!session.data) return <LoadingState label="Redirecting to sign in" />;
  return children;
}
