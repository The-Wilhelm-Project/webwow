import '@/app/globals.css';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import RootLayoutShell, { defaultMetadata } from '@/components/RootLayoutShell';

// Inter powers the builder's UI. It is loaded here (not in the shared shell)
// so published public pages don't ship the builder's font.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

// Webwow: brand icons, web app manifest and Open Graph image for the builder.
// Deliberately NOT in defaultMetadata: components/site-document-layout.tsx spreads
// that object into published pages, which would push Webwow's favicon and OG image
// onto customer sites. The asset files live in public/ (see scripts/sync-lists.sh).
export const metadata: Metadata = {
  ...defaultMetadata,
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  manifest: '/site.webmanifest',
  openGraph: {
    title: 'Webwow - Visual Website Builder',
    description: 'Self-hosted visual website builder',
    images: ['/og-image.png'],
  },
};

// Webwow: brand colour of the Wilhelm mark, used by mobile browser chrome.
export const viewport: Viewport = { themeColor: '#0369FF' };

export default function BuilderLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <RootLayoutShell lang="en" bodyClassName={`${inter.variable} font-sans antialiased text-xs`}>
      {children}
    </RootLayoutShell>
  );
}
