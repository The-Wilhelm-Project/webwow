import React from 'react';
import type { Metadata } from 'next';
import DarkModeProvider from '@/components/DarkModeProvider';
import { htmlDirFromLang } from '@/lib/html-lang';

// Webwow: white-label fork - the builder must not introduce itself as Ycode.
// Only the title/description live here; they are the fallback for published pages
// too, so brand icons, manifest and Open Graph stay in app/(builder)/layout.tsx.
export const defaultMetadata: Metadata = {
  title: 'Webwow - Visual Website Builder',
  description: 'Self-hosted visual website builder',
};

interface RootLayoutShellProps {
  children: React.ReactNode;
  headElements?: React.ReactNode[];
  /**
   * Classes applied to <body>. Consumers can include a `next/font` variable
   * (e.g. `${inter.variable}`) so a font is only loaded on the routes that
   * need it. Defaults to a font-free `font-sans antialiased` so generic
   * `font-sans` references fall back to the system stack — this is what
   * public published sites should use to avoid shipping the builder's UI font.
   */
  bodyClassName?: string;
  /**
   * Language for the <html lang> attribute. Published sites pass the locale
   * resolved from the URL so lang and dir are present in the SSR HTML.
   */
  lang?: string;
}

export default function RootLayoutShell({
  children,
  headElements,
  bodyClassName = 'font-sans antialiased',
  lang,
}: RootLayoutShellProps) {
  const dir = lang ? htmlDirFromLang(lang) : undefined;

  return (
    <html
      lang={lang}
      dir={dir}
      suppressHydrationWarning
    >
      <head>
        {headElements}
      </head>
      <body className={bodyClassName} suppressHydrationWarning>
        <DarkModeProvider>
          {children}
        </DarkModeProvider>
      </body>
    </html>
  );
}
