import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pagePathFromOutputKey } from '@/lib/apps/static-export/paths';
import { buildDocumentSeoLinks, shouldEmitHreflang } from '@/lib/document-seo-links';

import type { Locale, Page, PageFolder } from '@/types';

const en = {
  id: 'loc-en',
  code: 'en',
  label: 'English',
  is_default: true,
  is_published: true,
  created_at: '',
  updated_at: '',
  deleted_at: null,
} as Locale;

const fr = {
  id: 'loc-fr',
  code: 'fr',
  label: 'French',
  is_default: false,
  is_published: true,
  created_at: '',
  updated_at: '',
  deleted_at: null,
} as Locale;

function page(partial: Partial<Page> & Pick<Page, 'id' | 'name' | 'slug'>): Page {
  return {
    is_published: true,
    is_index: false,
    is_dynamic: false,
    error_page: null,
    page_folder_id: null,
    settings: {},
    ...partial,
  } as Page;
}

test('pagePathFromOutputKey maps export files to public paths', () => {
  assert.equal(pagePathFromOutputKey('index.html'), '/');
  assert.equal(pagePathFromOutputKey('about/index.html'), '/about');
  assert.equal(pagePathFromOutputKey('fr/about/index.html'), '/fr/about');
  assert.equal(pagePathFromOutputKey('fr/index.html'), '/fr');
  assert.equal(pagePathFromOutputKey('404.html'), null);
  assert.equal(pagePathFromOutputKey('401.html'), null);
});

test('shouldEmitHreflang skips preview, error, and noindex pages', () => {
  const about = page({ id: 'p1', name: 'About', slug: 'about' });
  assert.equal(shouldEmitHreflang(about), true);
  assert.equal(shouldEmitHreflang(about, true), false);
  assert.equal(shouldEmitHreflang(page({ id: 'p2', name: '404', slug: '404', error_page: 404 })), false);
  assert.equal(
    shouldEmitHreflang(page({
      id: 'p3',
      name: 'Hidden',
      slug: 'hidden',
      settings: { seo: { noindex: true, title: '', description: '', image: null } },
    })),
    false,
  );
});

test('buildDocumentSeoLinks emits canonical, og:url, and hreflang', () => {
  const about = page({ id: 'p1', name: 'About', slug: 'about' });
  const links = buildDocumentSeoLinks({
    pagePath: '/about',
    baseUrl: 'https://example.com',
    page: about,
    folders: [] as PageFolder[],
    locales: [en, fr],
    translationsByLocale: new Map(),
  });

  assert.equal(links.canonical, 'https://example.com/about');
  assert.equal(links.ogUrl, 'https://example.com/about');
  assert.deepEqual(
    links.hreflang.map((alt) => alt.hreflang),
    ['en', 'fr', 'x-default'],
  );
  assert.equal(
    links.hreflang.find((alt) => alt.hreflang === 'x-default')?.href,
    'https://example.com/about',
  );
});

test('buildDocumentSeoLinks is a no-op without a base URL or for error pages', () => {
  const about = page({ id: 'p1', name: 'About', slug: 'about' });
  assert.deepEqual(
    buildDocumentSeoLinks({
      pagePath: '/about',
      baseUrl: null,
      page: about,
      folders: [],
      locales: [en, fr],
      translationsByLocale: new Map(),
    }),
    { canonical: null, ogUrl: null, hreflang: [] },
  );

  const notFound = page({ id: 'p2', name: '404', slug: '404', error_page: 404 });
  assert.deepEqual(
    buildDocumentSeoLinks({
      pagePath: '/missing',
      baseUrl: 'https://example.com',
      page: notFound,
      folders: [],
      locales: [en, fr],
      translationsByLocale: new Map(),
    }),
    { canonical: null, ogUrl: null, hreflang: [] },
  );
});

test('noindex pages keep canonical and og:url but drop hreflang', () => {
  const hidden = page({
    id: 'p3',
    name: 'Hidden',
    slug: 'hidden',
    settings: { seo: { noindex: true, title: '', description: '', image: null } },
  });
  const links = buildDocumentSeoLinks({
    pagePath: '/hidden',
    baseUrl: 'https://example.com',
    page: hidden,
    folders: [],
    locales: [en, fr],
    translationsByLocale: new Map(),
  });

  assert.equal(links.canonical, 'https://example.com/hidden');
  assert.equal(links.ogUrl, 'https://example.com/hidden');
  assert.deepEqual(links.hreflang, []);
});
