import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net from 'net';
import { gzipSync } from 'zlib';
import { patchHtmlResponseStamp } from '@/lib/stamp-html-response';

const HTML = '<!DOCTYPE html><html><head><title>t</title></head><body>hi</body></html>';

interface RawResponse {
  body: string;
  declaredLength: number | null;
  bodyBytes: number;
}

/**
 * Issue a raw HTTP/1.1 request so header/body consistency is observable on the
 * wire — a Content-Length that disagrees with the body is what truncates
 * documents at the proxy.
 */
async function serveAndGet(
  responder: (res: http.ServerResponse) => void,
  path = '/'
): Promise<RawResponse> {
  const server = http.createServer(async (_req, res) => {
    // Next.js awaits async work (cache lookup) before responding, so the
    // patch's queueMicrotask wrap has landed by the time anything is written.
    await new Promise((resolve) => setTimeout(resolve, 0));
    responder(res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  const raw = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.on('end', () => resolve(buffer));
    socket.on('error', reject);
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));

  const separator = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, separator);
  const body = raw.slice(separator + 4);
  const declared = /content-length: (\d+)/i.exec(head)?.[1];

  return {
    body,
    declaredLength: declared === undefined ? null : Number(declared),
    bodyBytes: Buffer.byteLength(body, 'utf8'),
  };
}

patchHtmlResponseStamp();

test('stamps a buffered response without contradicting Content-Length', async () => {
  const result = await serveAndGet((res) => {
    const buf = Buffer.from(HTML, 'utf8');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-length', String(buf.byteLength));
    res.end(buf);
  });

  assert.ok(result.body.includes('Made in Ycode'));
  assert.ok(result.body.trimEnd().endsWith('</html>'));
  assert.equal(result.declaredLength, result.bodyBytes);
});

test('stamps a chunked response and drops the stale Content-Length', async () => {
  const result = await serveAndGet((res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-length', String(Buffer.byteLength(HTML, 'utf8')));
    res.write('<!DOCTYPE html><html><head><title>t</title></head>');
    res.end('<body>hi</body></html>');
  });

  assert.ok(result.body.includes('Made in Ycode'));
  assert.ok(result.body.includes('</html>'));
  assert.equal(result.declaredLength, null);
});

test('leaves gzip-compressed bytes untouched', async () => {
  const gzipped = gzipSync(Buffer.from(HTML, 'utf8'));
  const result = await serveAndGet((res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-encoding', 'gzip');
    res.setHeader('content-length', String(gzipped.byteLength));
    res.end(gzipped);
  });

  assert.ok(!result.body.includes('Made in Ycode'));
  assert.equal(result.declaredLength, gzipped.byteLength);
});

test('skips non-HTML responses', async () => {
  const json = JSON.stringify({ ok: true });
  const result = await serveAndGet((res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('content-length', String(Buffer.byteLength(json, 'utf8')));
    res.end(json);
  });

  assert.equal(result.body, json);
  assert.equal(result.declaredLength, result.bodyBytes);
});

test('skips builder routes', async () => {
  const result = await serveAndGet((res) => {
    const buf = Buffer.from(HTML, 'utf8');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-length', String(buf.byteLength));
    res.end(buf);
  }, '/ycode/pages');

  assert.ok(!result.body.includes('Made in Ycode'));
  assert.equal(result.declaredLength, result.bodyBytes);
});
