'use client';

import React, { useRef, useState, useEffect } from 'react';

interface HtmlEmbedRendererProps {
  code: string;
}

/**
 * Renders raw HTML/script code by injecting it into the DOM after mount.
 * Returns null during SSR and initial hydration to avoid mismatches,
 * then mounts a div and injects the code client-side only.
 * Scripts are re-created as real <script> elements so browsers execute them.
 */
export default function HtmlEmbedRenderer({ code }: HtmlEmbedRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !code) return;

    el.innerHTML = code;

    // innerHTML doesn't execute <script> tags — clone them as new elements
    const scripts = el.querySelectorAll('script');
    scripts.forEach((original) => {
      const replacement = document.createElement('script');
      Array.from(original.attributes).forEach((attr) => {
        replacement.setAttribute(attr.name, attr.value);
      });
      replacement.textContent = original.textContent;
      original.parentNode?.replaceChild(replacement, original);
    });

    return () => {
      el.innerHTML = '';
    };
  }, [isMounted, code]);

  if (!isMounted) return null;

  return <div ref={containerRef} />;
}
