import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Trade the Pool',
  description: 'Competitive paper trading platform',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
