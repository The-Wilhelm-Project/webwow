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

import http from 'node:http';
import {
  BUDGET_EXHAUSTED_ERROR,
  ByteBudget,
  DEFAULT_ALLOWED_HOSTS,
  checkUrlSafety,
  envAllowedHosts,
  envRelaxedHosts,
  filenameFromUrl,
  isAllowedHost,
  isPrivateAddress,
  resolveSafeUrl,
  safeFetch,
} from './safe-fetch';

/** A throwaway HTTP server on the loopback; records every request it sees. */
function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number; hits: { url: string; host: string }[] }> {
  const hits: { url: string; host: string }[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      hits.push({ url: req.url ?? '', host: req.headers.host ?? '' });
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, hits }));
  });
}

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

test('envRelaxedHosts: the operator list widens only outside production; safeFetch relaxes nothing on its own', async () => {
  assert.deepEqual(envRelaxedHosts('localhost', 'production'), []);
  assert.deepEqual(envRelaxedHosts('localhost,fixture.test', 'development').map(String), ['/^localhost$/i', '/^fixture\\.test$/i']);
  assert.deepEqual(envRelaxedHosts('localhost', undefined).length, 1);
  assert.deepEqual(envRelaxedHosts(undefined, 'development'), []);

  const loopback = async () => [{ address: '127.0.0.1' }];
  const url = new URL('http://localhost:8090/');
  const allow = [/^localhost$/i];
  assert.equal(await checkUrlSafety(url, allow, loopback), 'only https URLs are allowed (http:)');
  assert.equal(await checkUrlSafety(url, allow, loopback, { allowHttp: true }), 'host localhost resolves to a non-public address');
  assert.equal(await checkUrlSafety(url, allow, loopback, { relaxedHosts: [/^localhost$/i] }), null);
  assert.equal(await checkUrlSafety(url, allow, loopback, { relaxedHosts: [/^other$/i] }), 'only https URLs are allowed (http:)');
  assert.deepEqual(await resolveSafeUrl(url, allow, loopback, { relaxedHosts: [/^localhost$/i] }), { problem: null, addresses: ['127.0.0.1'] });
  assert.deepEqual(await resolveSafeUrl(new URL('https://93.184.216.34/x'), [/.*/], loopback), { problem: null, addresses: ['93.184.216.34'] });

  // The env list is never the default: with WEBWOW_IMPORT_ALLOWED_HOSTS set, safeFetch still
  // refuses http on the loopback unless the caller passes the relaxation itself.
  const { fetchImpl, calls } = stubFetch(() => body(4));
  process.env.WEBWOW_IMPORT_ALLOWED_HOSTS = 'localhost';
  try {
    const refused = await safeFetch('http://localhost:8090/x.jpg', { fetchImpl, lookupImpl: loopback });
    assert.equal(refused.ok, false);
    const relaxed = await safeFetch('http://localhost:8090/x.jpg', { fetchImpl, lookupImpl: loopback, relaxedHosts: envRelaxedHosts('localhost', 'development') });
    assert.ok(relaxed.ok);
    assert.deepEqual(calls, ['http://localhost:8090/x.jpg']);
  } finally {
    delete process.env.WEBWOW_IMPORT_ALLOWED_HOSTS;
  }
});

test('the socket connects to the validated address, not to a second DNS answer', async () => {
  const { server, port, hits } = await listen((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><body>internal</body></html>');
  });
  try {
    // Pinning: `pinned.invalid` never resolves through the system, so the request can only
    // reach the local server through the validated address; Host stays the hostname.
    const pinned = await safeFetch(`http://pinned.invalid:${port}/page.html`, {
      allowHosts: [/^pinned\.invalid$/], relaxedHosts: [/^pinned\.invalid$/], lookupImpl: async () => [{ address: '127.0.0.1' }],
    });
    assert.ok(pinned.ok, JSON.stringify(pinned));
    assert.equal(pinned.buffer.toString(), '<html><body>internal</body></html>');
    assert.equal(pinned.contentType, 'text/html');
    assert.deepEqual(hits, [{ url: '/page.html', host: `pinned.invalid:${port}` }]);

    // Rebinding: validation saw a public address for `localhost`; the connection must go to
    // that address (unroutable TEST-NET here), never to 127.0.0.1 where the server listens.
    hits.length = 0;
    const rebound = await safeFetch(`http://localhost:${port}/secret`, {
      allowHosts: [/^localhost$/], allowHttp: true, relaxedHosts: [], lookupImpl: async () => [{ address: '192.0.2.1' }], timeoutMs: 400,
    });
    assert.equal(rebound.ok, false);
    assert.deepEqual(hits, [], 'the loopback server was never contacted');

    // A redirect hop is resolved and pinned again: the first hop lands on the server, the
    // second names a host that resolves privately and is refused before any connection.
    hits.length = 0;
    const { server: redirector, port: rport, hits: rhits } = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `http://internal.invalid:${port}/admin`);
      res.end();
    });
    try {
      const hop = await safeFetch(`http://edge.invalid:${rport}/`, {
        allowHosts: [/\.invalid$/], allowHttp: true, relaxedHosts: [/^edge\.invalid$/],
        lookupImpl: async (host) => [{ address: host === 'edge.invalid' ? '127.0.0.1' : '10.0.0.9' }],
      });
      assert.equal(hop.ok, false);
      assert.match((hop as { error: string }).error, /non-public/);
      assert.equal(rhits.length, 1);
      assert.deepEqual(hits, [], 'the internal target was never contacted');
    } finally {
      redirector.close();
    }
  } finally {
    server.close();
  }
});

test('a chunked body without content-length is cut off the moment the budget runs out', async () => {
  const budget = new ByteBudget(10);
  assert.ok(budget.take(4));
  let aborted = false;
  let sent = 0;
  const { fetchImpl, calls } = stubFetch((_url, init) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; });
    const chunk = new Uint8Array(4).fill(1);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 4000) { controller.close(); return; }
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    return new Response(stream, { status: 200 });
  });
  const res = await safeFetch(CDN, { fetchImpl, lookupImpl: publicLookup, budget });
  assert.deepEqual(res, { ok: false, error: BUDGET_EXHAUSTED_ERROR });
  assert.ok(aborted, 'the transfer was aborted');
  assert.ok(sent <= 16, `only the budget's worth was transferred (${sent} bytes)`);
  assert.equal(budget.used, 4, 'the cut-off download reserves nothing');
  // An exhausted budget makes no request at all.
  assert.ok(budget.take(6));
  const none = await safeFetch(CDN, { fetchImpl, lookupImpl: publicLookup, budget });
  assert.deepEqual(none, { ok: false, error: BUDGET_EXHAUSTED_ERROR });
  assert.equal(calls.length, 1);
});

test('isPrivateAddress covers every reserved range', () => {
  for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1', '127.255.0.9', '169.254.1.1', '169.254.169.254', '0.0.0.0', '0.1.2.3', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd00::1', 'fe80::1', 'FE80::abcd%eth0', 'ff02::1', '::ffff:192.168.0.1', '::ffff:10.1.1.1', '::ffff:c0a8:1', '2002:c0a8:0001::1', '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '64:ff9b::a9fe:a9fe', 'garbage', '1.2.3', '::ffff:999.1.1.1']) {
    assert.ok(isPrivateAddress(ip), `${ip} should be private`);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '100.63.0.1', '100.128.0.1', '2606:4700::6810:84e5', '::ffff:93.184.216.34', '2001:db8::1', '64:ff9b::5db8:d822']) {
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
