import { TradingTerminal } from '@/components/trading-terminal';

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string; entryId: string }>;
}) {
  const { slug, entryId } = await params;
  return <TradingTerminal slug={slug} entryId={entryId} />;
}
