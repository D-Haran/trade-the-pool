import { LoginPage } from '@/components/login-page';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const requested = (await searchParams).returnTo;
  const returnTo =
    requested?.startsWith('/') && !requested.startsWith('//') ? requested : '/dashboard';
  return <LoginPage returnTo={returnTo} />;
}
