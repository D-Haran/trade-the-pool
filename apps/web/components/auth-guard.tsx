'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { LoadingState } from './ui/states';

export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useQuery({ queryKey: queryKeys.session, queryFn: api.session, retry: false });
  useEffect(() => {
    if (!session.isLoading && !session.data)
      router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`);
  }, [pathname, router, session.data, session.isLoading]);
  if (session.isLoading || !session.data) return <LoadingState label="Restoring your session" />;
  return children;
}
