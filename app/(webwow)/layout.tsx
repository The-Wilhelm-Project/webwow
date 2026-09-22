import '@/app/globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';

/**
 * Root layout of the Webwow route group (`/webwow` sites dashboard, `/webwow/edit`
 * editor login). Deliberately NOT `RootLayoutShell`: its `DarkModeProvider`
 * strips `.dark` from `<html>` outside `/ycode`, and the dashboard is always dark.
 */

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Webwow — Sites',
  description: 'Manage your websites',
};

export const dynamic = 'force-dynamic';

export default function WebwowLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="dark"
      suppressHydrationWarning
    >
      <body
        className={`${inter.variable} font-sans antialiased text-xs bg-background text-foreground min-h-screen`}
        suppressHydrationWarning
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
