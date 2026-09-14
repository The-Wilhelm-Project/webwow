'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Resolves whether dark mode should be active based on the user's
 * saved theme preference and the system color scheme.
 */
function shouldApplyDark(): boolean {
  const saved = localStorage.getItem('theme') as 'system' | 'light' | 'dark' | null;
  const theme = saved || 'dark';

  if (theme === 'light') return false;
  if (theme === 'dark') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * DarkModeProvider
 * 
 * Client component that applies dark mode class to <html> element
 * based on the current pathname. This avoids using headers() in
 * the root layout which would force all pages to be dynamic.
 * 
 * For /ycode/* routes (except preview), it respects the user's
 * saved theme preference from localStorage.
 * For all other routes, dark mode is removed.
 */
export default function DarkModeProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  
  useEffect(() => {
    const isPreviewRoute = pathname?.startsWith('/ycode/preview');
    const isBuilderRoute = !isPreviewRoute && pathname?.startsWith('/ycode');
    
    if (isBuilderRoute) {
      if (shouldApplyDark()) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [pathname]);

  return <>{children}</>;
}
