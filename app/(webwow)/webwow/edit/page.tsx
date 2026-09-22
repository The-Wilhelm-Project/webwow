import Link from 'next/link';
import type { Metadata } from 'next';
import { getSite, registryAvailable } from '@/lib/webwow/sites/registry';
import { isSiteId } from '@/lib/webwow/sites/ids';
import { validateReturnPath } from '@/lib/webwow/editor/return-path';
import { EditLoginForm } from './EditLoginForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Edit site — Webwow',
};

interface EditPageProps {
  searchParams: Promise<{ site?: string; return?: string }>;
}

/**
 * `/webwow/edit` — the landing page of the `?edit` content editor.
 *
 * The proxy sends visitors here when a published page is opened with `?edit`
 * (see proxy.ts and docs/EDITOR.md). Nothing about the site is revealed beyond
 * its name: the password hash never leaves the server.
 */
export default async function EditPage({ searchParams }: EditPageProps) {
  const params = await searchParams;
  const site = (await registryAvailable()) && params.site && isSiteId(params.site) ? await getSite(params.site) : null;
  const returnPath = validateReturnPath(params.return) ?? '/';

  if (!site) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950 p-6">
        <div className="w-full max-w-sm rounded-xl border border-white/10 bg-neutral-900 p-6 text-center">
          <h1 className="text-sm font-medium text-white">This site does not exist</h1>
          <p className="mt-2 text-xs text-white/60">The editor link points to a site that is no longer available.</p>
          <Link href="/" className="mt-4 inline-block text-xs text-blue-400 hover:underline">
            Back to the website
          </Link>
        </div>
      </div>
    );
  }

  return (
    <EditLoginForm
      siteId={site.id}
      siteName={site.name}
      editorEnabled={site.editor_password_hash !== null}
      returnPath={returnPath}
    />
  );
}
