'use client';

import { LogIn, LogOut, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export function SessionControl() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: queryKeys.session, queryFn: api.session, retry: false });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      queryClient.setQueryData(queryKeys.session, null);
      await queryClient.invalidateQueries({ queryKey: ['entries'] });
      router.push('/');
    },
  });
  if (session.isLoading)
    return <span className="session-placeholder" aria-label="Restoring session" />;
  if (!session.data)
    return (
      <Link className="session-link" href={`/login?returnTo=${encodeURIComponent(pathname)}`}>
        <LogIn aria-hidden="true" /> <span>Sign in</span>
      </Link>
    );
  return (
    <div className="session-user">
      <UserRound aria-hidden="true" />
      <span>{session.data.displayName}</span>
      <button onClick={() => logout.mutate()} disabled={logout.isPending} aria-label="Sign out">
        <LogOut aria-hidden="true" />
      </button>
    </div>
  );
}
