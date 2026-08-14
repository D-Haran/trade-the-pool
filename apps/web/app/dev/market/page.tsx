import { notFound } from 'next/navigation';
import { DevMarketPage } from '@/components/dev-market-page';

export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <DevMarketPage />;
}
