'use client';

import { useEffect } from 'react';

import { recreateScript } from '@/lib/script-utils';

interface HeadCodeInjectorProps {
  html: string;
  id: string;
}

/**
 * Injects custom HTML elements into document.head via useEffect.
 * Next.js streaming SSR prevents React 19 hoisting from working for
 * page-level content, so we programmatically append all elements
 * (meta, link, style, script, noscript) to document.head client-side.
 * External scripts are loaded sequentially to preserve dependency order.
 */
export default function HeadCodeInjector({ html, id }: HeadCodeInjectorProps) {
  useEffect(() => {
    const temp = document.createElement('div');
    temp.innerHTML = html;

    const elements = Array.from(temp.children);
    const injected: Element[] = [];
    let cancelled = false;

    async function injectElements() {
      for (let i = 0; i < elements.length; i++) {
        if (cancelled) return;
        const original = elements[i];
        const tag = `${id}-${i}`;

        if (original.tagName === 'SCRIPT') {
          const script = recreateScript(original as HTMLScriptElement);
          script.dataset.meta = tag;
          injected.push(script);

          if (script.src) {
            await new Promise<void>((resolve) => {
              script.addEventListener('load', () => resolve());
              script.addEventListener('error', () => resolve());
              document.head.appendChild(script);
            });
          } else {
            document.head.appendChild(script);
          }
        } else {
          const clone = original.cloneNode(true) as Element;
          clone.setAttribute('data-meta', tag);
          document.head.appendChild(clone);
          injected.push(clone);
        }
      }
    }

    injectElements();

    return () => {
      cancelled = true;
      injected.forEach((el) => el.remove());
    };
  }, [html, id]);

  return null;
}
