import './globals.css';
import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: 'Trade the Pool',
  description:
    'Competitive paper trading where the prize pool grows new-entry bankrolls and dollar P&L sets rank.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
