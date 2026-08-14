'use client';

import { ArrowRight, LockKeyhole, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiClientError } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { Button } from './ui/button';
import { ErrorState, LoadingState } from './ui/states';

export function LoginPage({ returnTo }: { returnTo: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: queryKeys.devUsers, queryFn: api.devUsers, retry: false });
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: ({ data }) => {
      queryClient.setQueryData(queryKeys.session, data.user);
      router.replace(returnTo);
    },
  });
  const unavailable = users.error instanceof ApiClientError && users.error.status === 404;
  return (
    <div className="login-page content-width">
      <section className="login-panel">
        <div className="login-panel__intro">
          <span className="dev-label">
            <LockKeyhole aria-hidden="true" /> Development only
          </span>
          <h1>Select a local user.</h1>
          <p>
            This environment uses backend-issued development sessions. It is not production
            authentication.
          </p>
        </div>
        <div className="login-panel__users">
          {users.isLoading ? <LoadingState label="Checking development access" /> : null}
          {unavailable ? (
            <ErrorState
              title="Development sign-in unavailable"
              detail="The backend has not enabled its development-only login routes."
            />
          ) : null}
          {users.isError && !unavailable ? (
            <ErrorState title="Authentication service unavailable" retry={() => users.refetch()} />
          ) : null}
          {users.data?.data.map((user) => (
            <Button
              key={user.id}
              variant="secondary"
              className="user-choice"
              disabled={login.isPending}
              onClick={() => login.mutate(user.id)}
            >
              <span className="user-choice__avatar">
                <UserRound aria-hidden="true" />
              </span>
              <span>
                <strong>{user.displayName}</strong>
                <small>Local development profile</small>
              </span>
              <ArrowRight aria-hidden="true" />
            </Button>
          ))}
          {login.isError ? (
            <p className="form-error" role="alert">
              {login.error instanceof Error ? login.error.message : 'Sign-in failed.'}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
