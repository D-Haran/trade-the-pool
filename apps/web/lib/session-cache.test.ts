import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryKeys } from './query-keys';
import { clearSessionScopedQueries } from './session-cache';

describe('clearSessionScopedQueries', () => {
  it('removes user-dependent eligibility and private account data', () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(queryKeys.session, { id: 'user-a' });
    queryClient.setQueryData(queryKeys.tournaments(), { data: [] });
    queryClient.setQueryData(queryKeys.tournament('weekend-pool'), {
      data: { eligibleToEnter: false },
    });
    queryClient.setQueryData(queryKeys.entries(), { data: [] });
    queryClient.setQueryData(queryKeys.entry('entry-a'), { data: { id: 'entry-a' } });
    queryClient.setQueryData(queryKeys.market('BTC-USD'), { data: { price: '100000.00' } });

    clearSessionScopedQueries(queryClient);

    expect(queryClient.getQueryData(queryKeys.session)).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.tournaments())).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.tournament('weekend-pool'))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.entries())).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.entry('entry-a'))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.market('BTC-USD'))).toEqual({
      data: { price: '100000.00' },
    });
  });
});
