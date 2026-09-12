'use client';

import { useEffect, useState } from 'react';
import LayerRendererPublic from '@/components/LayerRendererPublic';
import YcodeBadge from '@/components/YcodeBadge';
import type { PageData } from '@/lib/page-fetcher';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Root error boundary for published pages
 * Shows custom 500 error page if available
 */
export default function Error({ error, reset }: ErrorProps) {
  const [errorPageData, setErrorPageData] = useState<PageData | null>(null);
  const [generatedCss, setGeneratedCss] = useState<string>('');
  const [colorVariablesCss, setColorVariablesCss] = useState<string>('');
  const [showBadge, setShowBadge] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    console.error('Published page error:', error);

    async function fetchErrorPage() {
      try {
        const response = await fetch('/ycode/api/error-page?code=500&published=true');
        if (response.ok) {
          const data = await response.json();
          setErrorPageData(data.pageData);
          setGeneratedCss(data.css || '');
          setColorVariablesCss(data.colorVariablesCss || '');
          setShowBadge(data.ycodeBadge ?? true);
        }
      } catch (err) {
        console.error('Failed to fetch custom 500 page:', err);
      } finally {
        setIsLoading(false);
      }
    }

    fetchErrorPage();
  }, [error]);

  if (isLoading) return null;

  if (errorPageData) {
    const customCodeHead = errorPageData.page.settings?.custom_code?.head || '';
    const customCodeBody = errorPageData.page.settings?.custom_code?.body || '';

    return (
      <>
        {generatedCss && (
          <style
            id="ycode-styles"
            dangerouslySetInnerHTML={{ __html: generatedCss }}
          />
        )}
        {colorVariablesCss && (
          <style
            id="ycode-color-vars"
            dangerouslySetInnerHTML={{ __html: colorVariablesCss }}
          />
        )}
        {customCodeHead && (
          <div dangerouslySetInnerHTML={{ __html: customCodeHead }} />
        )}
        <div className="min-h-screen bg-white">
          <LayerRendererPublic
            layers={errorPageData.pageLayers.layers || []}
            isPublished={true}
            pageCollectionItemData={errorPageData.collectionItem?.values || undefined}
          />
        </div>
        {customCodeBody && (
          <div dangerouslySetInnerHTML={{ __html: customCodeBody }} />
        )}
        {showBadge && <YcodeBadge />}
      </>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <div className="text-center max-w-md px-4">
        <h1 className="text-6xl font-bold text-gray-900 mb-4">500</h1>
        <h2 className="text-2xl font-semibold text-gray-800 mb-4">Server Error</h2>
        <p className="text-gray-600 mb-8">
          Something went wrong on our end. Please try again later.
        </p>
        <button
          onClick={reset}
          className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Try Again
        </button>
      </div>
      {showBadge && <YcodeBadge />}
    </div>
  );
}
