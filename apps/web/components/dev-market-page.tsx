'use client';

import type { MarketSymbolDto } from '@trade-the-pool/shared';
import { useState } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { formatPrice } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { AuthGuard } from './auth-guard';
import { Button } from './ui/button';

const symbols: MarketSymbolDto[] = ['BTC-USD', 'ETH-USD', 'SOL-USD'];

function Controls() {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<MarketSymbolDto, string>>({
    'BTC-USD': '100000.00',
    'ETH-USD': '4000.00',
    'SOL-USD': '200.00',
  });
  const marketQueries = useQueries({
    queries: symbols.map((symbol) => ({
      queryKey: queryKeys.market(symbol),
      queryFn: () => api.market(symbol),
    })),
  });
  const markets = symbols.map((symbol, index) => ({ symbol, query: marketQueries[index] }));
  const advance = useMutation({
    mutationFn: ({ symbol, price }: { symbol: MarketSymbolDto; price: string }) =>
      api.advanceMarket(symbol, price),
    onSuccess: ({ data }) => queryClient.setQueryData(queryKeys.market(data.symbol), { data }),
  });
  return (
    <div className="page content-width">
      <header className="page-header">
        <div>
          <span className="dev-label">Development only</span>
          <h1>Market controls</h1>
        </div>
        <p>
          Advance the shared deterministic market source for local tests. This route is not
          available in production.
        </p>
      </header>
      <div className="dev-market-grid">
        {markets.map(({ symbol, query }) => (
          <section key={symbol}>
            <span>{symbol.replace('-', '/')}</span>
            <strong className="tabular">
              {query.data ? formatPrice(query.data.data.price) : '—'}
            </strong>
            <label>
              <span>Next price</span>
              <input
                value={values[symbol]}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [symbol]: event.target.value }))
                }
                inputMode="decimal"
              />
            </label>
            <Button
              disabled={advance.isPending}
              onClick={() => advance.mutate({ symbol, price: values[symbol] })}
            >
              Advance market
            </Button>
          </section>
        ))}
      </div>
      {advance.isError ? (
        <p className="form-error" role="alert">
          {advance.error instanceof Error ? advance.error.message : 'Market update failed.'}
        </p>
      ) : null}
    </div>
  );
}

export function DevMarketPage() {
  return (
    <AuthGuard>
      <Controls />
    </AuthGuard>
  );
}
