import type { QueryClient } from '@tanstack/react-query';

const sessionScopedQueryRoots = new Set([
  'session',
  'tournaments',
  'tournament',
  'entries',
  'entry',
  'wallets',
]);

/**
 * Remove every query whose response can vary by authenticated user.
 *
 * Tournament responses are included because they contain `eligibleToEnter`, even though most of
 * their fields are public. Private entry/account queries must also never survive an account
 * change.
 */
export function clearSessionScopedQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: ({ queryKey }) => sessionScopedQueryRoots.has(String(queryKey[0])),
  });
}
