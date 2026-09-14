import type { HreflangAlternate } from '@/lib/hreflang-utils';

interface HreflangAlternateLinksProps {
  alternates: HreflangAlternate[];
}

/**
 * Renders the `<link rel="alternate" hreflang="...">` cluster into the document
 * head. Used by SiteDocumentLayout so the links are in the first HTML byte.
 * Uses the lowercase `hreflang` attribute (HTML standard / Google's
 * convention) instead of React's `hrefLang` prop, which React 19 emits verbatim
 * as camelCase.
 */
export default function HreflangAlternateLinks({ alternates }: HreflangAlternateLinksProps) {
  if (alternates.length === 0) {
    return null;
  }

  return (
    <>
      {alternates.map((alt) => (
        <link
          key={alt.hreflang}
          {...({ rel: 'alternate', hreflang: alt.hreflang, href: alt.href } as Record<string, string>)}
        />
      ))}
    </>
  );
}
