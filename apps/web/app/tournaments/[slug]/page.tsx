import { TournamentDetail } from '@/components/tournament-detail';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <TournamentDetail slug={(await params).slug} />;
}
