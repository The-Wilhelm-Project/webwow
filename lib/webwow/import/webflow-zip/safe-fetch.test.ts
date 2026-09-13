import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// safe-fetch.ts imports `@/lib/webwow/storage` (guessMimeType), which carries `import 'server-only'`.
{
  const filename = require.resolve('server-only');
  const mod = new Module(filename) as Module & { loaded: boolean };
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = {};
  require.cache[filename] = mod;
}

import {
  ByteBudget,
  DEFAULT_ALLOWED_HOSTS,
  envAllowedHosts,
  filenameFromUrl,
  isAllowedHost,
  isPrivateAddress,
  safeFetch,
} from './safe-fetch';

const CDN = 'https://cdn.prod.website-files.com/696e3e261a55566a62dc5508/6973b0695bd4b92617308ffa_02-Sudisland.jpg';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function stubFetch(handler: Handler): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const publicLookup = async () => [{ address: '93.184.216.34' }];

function body(bytes: number, headers: Record<string, string> = {}): Response {
  return new Response(new Uint8Array(bytes).fill(7), { status: 200, headers });
}

test('only https URLs on allowlisted hosts are fetched', async () => {
  const { fetchImpl, calls } = stubFetch(() => body(4));
  const http = await safeFetch('http://cdn.prod.website-files.com/x.jpg', { fetchImpl, lookupImpl: publicLookup });
  assert.deepEqual(http, { ok: false, error: 'only https URLs are allowed (http:)' });
  const other = await safeFetch('https://evil.example.com/x.jpg', { fetchImpl, lookupImpl: publicLookup });
  assert.equal(other.ok, false);
  assert.match((other as { error: string }).error, /not in the allowlist/);
  const creds = await safeFetch('https://user:pw@cdn.prod.website-files.com/x.jpg', { fetchImpl, lookupImpl: publicLookup });
  assert.match((creds as { error: string }).error, /credentials/);
  const invalid = await safeFetch('not a url', { fetchImpl, lookupImpl: publicLookup });
  assert.match((invalid as { error: string }).error, /invalid URL/);
  const storage = await safeFetch('/storage/v1/object/public/assets/x.png', { fetchImpl, lookupImpl: publicLookup });
  assert.equal(storage.ok, false);
  assert.equal(calls.length, 0, 'nothing was fetched');
});

test('isAllowedHost / envAllowedHosts', () => {
  assert.ok(isAllowedHost('cdn.prod.website-files.com', DEFAULT_ALLOWED_HOSTS));
  assert.ok(isAllowedHost('assets-global.website-files.com', DEFAULT_ALLOWED_HOSTS));
  assert.ok(isAllowedHost('uploads-ssl.webflow.com', DEFAULT_ALLOWED_HOSTS));
  assert.ok(isAllowedHost('d3e54v103j8qbb.cloudfront.net', DEFAULT_ALLOWED_HOSTS));
  assert.ok(isAllowedHost('CDN.PROD.WEBSITE-FILES.COM.', DEFAULT_ALLOWED_HOSTS));
  assert.ok(!isAllowedHost('evil-website-files.com', DEFAULT_ALLOWED_HOSTS));
  assert.ok(!isAllowedHost('website-files.com.evil.net', DEFAULT_ALLOWED_HOSTS));
  assert.ok(!isAllowedHost('other.cloudfront.net', DEFAULT_ALLOWED_HOSTS));
  assert.ok(!isAllowedHost('', DEFAULT_ALLOWED_HOSTS));
  const extra = envAllowedHosts('cdn.example.com, Media.Example.org ,bad host,,');
  assert.equal(extra.length, 2);
  assert.ok(isAllowedHost('cdn.example.com', extra));
  assert.ok(isAllowedHost('media.example.org', extra));
  assert.ok(!isAllowedHost('sub.cdn.example.com', extra), 'env entries are literal hostnames');
  assert.deepEqual(envAllowedHosts(undefined), []);
  assert.deepEqual(envAllowedHosts(''), []);
});

test('isPrivateAddress covers every reserved range', () => {
  for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1', '127.255.0.9', '169.254.1.1', '169.254.169.254', '0.0.0.0', '0.1.2.3', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd00::1', 'fe80::1', 'FE80::abcd%eth0', 'ff02::1', '::ffff:192.168.0.1', '::ffff:10.1.1.1', '::ffff:c0a8:1', '2002:c0a8:0001::1', 'garbage', '1.2.3', '::ffff:999.1.1.1']) {
    assert.ok(isPrivateAddress(ip), `${ip} should be private`);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '100.63.0.1', '100.128.0.1', '2606:4700::6810:84e5', '::ffff:93.184.216.34', '2001:db8::1']) {
    assert.ok(!isPrivateAddress(ip), `${ip} should be public`);
  }
});

test('a host resolving to a private address is rejected', async () => {
  const { fetchImpl, calls } = stubFetch(() => body(4));
  const res = await safeFetch(CDN, { fetchImpl, lookupImpl: async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }] });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /non-public/);
  assert.equal(calls.length, 0);
  const failed = await safeFetch(CDN, { fetchImpl, lookupImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.match((failed as { error: string }).error, /DNS lookup failed/);
  const empty = await safeFetch(CDN, { fetchImpl, lookupImpl: async () => [] });
  assert.match((empty as { error: string }).error, /no address/);
});

test('a successful download returns the body, content type and a de-prefixed filename', async () => {
  const { fetchImpl, calls } = stubFetch((_url, init) => {
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal instanceof AbortSignal);
    return body(12, { 'content-type': 'image/jpeg; charset=binary', 'content-length': '12' });
  });
  const res = await safeFetch(`${CDN}?v=2`, { fetchImpl, lookupImpl: publicLookup });
  assert.ok(res.ok);
  assert.equal(res.buffer.length, 12);
  assert.equal(res.buffer[0], 7);
  assert.equal(res.contentType, 'image/jpeg');
  assert.equal(res.filename, '02-Sudisland.jpg');
  assert.deepEqual(calls, [`${CDN}?v=2`]);
  // application/octet-stream falls back to the extension.
  const octet = await safeFetch(CDN, { fetchImpl: stubFetch(() => body(1, { 'content-type': 'application/octet-stream' })).fetchImpl, lookupImpl: publicLookup });
  assert.ok(octet.ok && octet.contentType === 'image/jpeg');
  assert.equal(filenameFromUrl('https://cdn.prod.website-files.com/abc/6973b0695bd4b92617308ffa_02-Sud%20island.jpg?x=1#y'), '02-Sud island.jpg');
  assert.equal(filenameFromUrl('https://cdn.prod.website-files.com/'), 'download');
});

test('non-2xx responses and missing bodies are reported, never thrown', async () => {
  const notFound = await safeFetch(CDN, { fetchImpl: stubFetch(() => new Response('nope', { status: 404 })).fetchImpl, lookupImpl: publicLookup });
  assert.deepEqual(notFound, { ok: false, error: 'HTTP 404' });
  const thrown = await safeFetch(CDN, { fetchImpl: stubFetch(() => { throw new Error('socket hang up'); }).fetchImpl, lookupImpl: publicLookup });
  assert.deepEqual(thrown, { ok: false, error: 'socket hang up' });
  const empty = await safeFetch(CDN, { fetchImpl: stubFetch(() => new Response(null, { status: 200 })).fetchImpl, lookupImpl: publicLookup });
  assert.ok(empty.ok && empty.buffer.length === 0);
});

test('the byte budget is enforced from content-length and from the streamed size', async () => {
  const budget = new ByteBudget(10);
  assert.ok(budget.take(4));
  assert.equal(budget.remaining, 6);
  assert.ok(!budget.take(7));
  assert.equal(budget.used, 4);
  assert.ok(!budget.take(-1));
  const declared = await safeFetch(CDN, { fetchImpl: stubFetch(() => body(8, { 'content-length': '8' })).fetchImpl, lookupImpl: publicLookup, budget });
  assert.deepEqual(declared, { ok: false, error: 'import download budget exhausted' });
  const streamed = await safeFetch(CDN, { fetchImpl: stubFetch(() => body(8)).fetchImpl, lookupImpl: publicLookup, budget });
  assert.deepEqual(streamed, { ok: false, error: 'import download budget exhausted' });
  assert.equal(budget.used, 4, 'a rejected download reserves nothing');
  const fits = await safeFetch(CDN, { fetchImpl: stubFetch(() => body(6)).fetchImpl, lookupImpl: publicLookup, budget });
  assert.ok(fits.ok);
  assert.equal(budget.used, 10);
});

test('oversized bodies are rejected by header or aborted mid-stream', async () => {
  const declared = await safeFetch(CDN, { fetchImpl: stubFetch(() => body(50, { 'content-length': '50' })).fetchImpl, lookupImpl: publicLookup, maxBytes: 10 });
  assert.deepEqual(declared, { ok: false, error: 'file larger than 0 MB' });
  let aborted = false;
  const { fetchImpl } = stubFetch((_url, init) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; });
    const chunk = new Uint8Array(4).fill(1);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 40) { controller.close(); return; }
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    return new Response(stream, { status: 200 });
  });
  const streamed = await safeFetch(CDN, { fetchImpl, lookupImpl: publicLookup, maxBytes: 10 });
  assert.deepEqual(streamed, { ok: false, error: 'file larger than 0 MB' });
  assert.ok(aborted, 'the request was aborted once the limit was crossed');
});

test('redirects are re-validated (private host, disallowed host, hop limit) and followed when safe', async () => {
  const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });
  const toPrivate = await safeFetch(CDN, {
    fetchImpl: stubFetch((url) => (url === CDN ? redirectTo('https://internal.website-files.com/x.jpg') : body(4))).fetchImpl,
    lookupImpl: async (host) => [{ address: host === 'internal.website-files.com' ? '10.0.0.9' : '93.184.216.34' }],
  });
  assert.equal(toPrivate.ok, false);
  assert.match((toPrivate as { error: string }).error, /non-public/);

  const toOther = await safeFetch(CDN, {
    fetchImpl: stubFetch((url) => (url === CDN ? redirectTo('https://evil.example/x.jpg') : body(4))).fetchImpl,
    lookupImpl: publicLookup,
  });
  assert.match((toOther as { error: string }).error, /allowlist/);

  const toHttp = await safeFetch(CDN, {
    fetchImpl: stubFetch((url) => (url === CDN ? redirectTo('http://cdn.prod.website-files.com/x.jpg') : body(4))).fetchImpl,
    lookupImpl: publicLookup,
  });
  assert.match((toHttp as { error: string }).error, /https/);

  const loop = await safeFetch(CDN, { fetchImpl: stubFetch(() => redirectTo('/again.jpg')).fetchImpl, lookupImpl: publicLookup, maxRedirects: 2 });
  assert.match((loop as { error: string }).error, /too many redirects/);

  const noLocation = await safeFetch(CDN, { fetchImpl: stubFetch(() => new Response(null, { status: 301 })).fetchImpl, lookupImpl: publicLookup });
  assert.match((noLocation as { error: string }).error, /without Location/);

  const { fetchImpl, calls } = stubFetch((url) => (url.endsWith('final.jpg') ? body(3, { 'content-type': 'image/jpeg' }) : redirectTo('/relative/final.jpg')));
  const followed = await safeFetch(CDN, { fetchImpl, lookupImpl: publicLookup });
  assert.ok(followed.ok);
  assert.equal(followed.buffer.length, 3);
  assert.equal(followed.filename, '02-Sudisland.jpg', 'the filename comes from the original URL');
  assert.deepEqual(calls, [CDN, 'https://cdn.prod.website-files.com/relative/final.jpg']);
});

test('a hanging server hits the timeout', async () => {
  const { fetchImpl } = stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    // A real socket keeps the event loop alive; the stub needs a ref'd timer for that.
    const keepAlive = setTimeout(() => reject(new Error('stub never aborted')), 5_000);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    });
  }));
  const res = await safeFetch(CDN, { fetchImpl, lookupImpl: publicLookup, timeoutMs: 30 });
  assert.deepEqual(res, { ok: false, error: 'timeout after 30 ms' });
});
