'use client';

import { useLayoutEffect } from 'react';
import { composeDocumentBodyClassName } from '@/lib/body-classes';

/**
 * Replaces `<body>` classes when the rendered page is not the URL's page
 * (password 401 / custom 404). Normal published pages bake classes into
 * the SSR `<body>` and do not need this.
 */
export default function BodyClassApplier({ classes }: { classes: string }) {
  useLayoutEffect(() => {
    const previous = document.body.className;
    document.body.className = composeDocumentBodyClassName(classes);
    return () => {
      document.body.className = previous;
    };
  }, [classes]);

  return null;
}
