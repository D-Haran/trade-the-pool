'use client';

import { LayoutDashboard, Trophy, Waves } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { SessionControl } from './session-control';

const links = [
  { href: '/tournaments', label: 'Tournaments', icon: Trophy },
  { href: '/dashboard', label: 'My Entries', icon: LayoutDashboard },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="app-frame">
      <header className="topbar">
        <div className="topbar__inner">
          <Link href="/" className="wordmark" aria-label="Trade the Pool home">
            <span className="wordmark__mark">
              <Waves aria-hidden="true" />
            </span>
            <span>Trade the Pool</span>
          </Link>
          <nav className="desktop-nav" aria-label="Primary navigation">
            {links.map(({ href, label }) => (
              <Link key={href} href={href} className={cn(pathname.startsWith(href) && 'is-active')}>
                {label}
              </Link>
            ))}
          </nav>
          <SessionControl />
        </div>
      </header>
      <main className="app-main">{children}</main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {links.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className={cn(pathname.startsWith(href) && 'is-active')}>
            <Icon aria-hidden="true" /> <span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
