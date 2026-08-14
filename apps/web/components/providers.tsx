'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { ToastProvider } from './ui/toast';
import { queryKeys } from '@/lib/query-keys';

function SessionExpiryBridge({ queryClient }: { queryClient: QueryClient }) {
  useEffect(() => {
    const expire = () => {
      queryClient.setQueryData(queryKeys.session, null);
      void queryClient.removeQueries({ queryKey: ['entries'] });
    };
    window.addEventListener('ttp:session-expired', expire);
    return () => window.removeEventListener('ttp:session-expired', expire);
  }, [queryClient]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            retry: (count, error) =>
              count < 2 &&
              (!(error instanceof Error) || !('status' in error) || error.status === 0),
            refetchOnWindowFocus: true,
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SessionExpiryBridge queryClient={queryClient} />
        {children}
      </ToastProvider>
    </QueryClientProvider>
  );
}
