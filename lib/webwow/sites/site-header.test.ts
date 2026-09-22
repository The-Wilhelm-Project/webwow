import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSiteHeader, signSiteHeaderWebCrypto, verifySiteHeader } from './site-header';

const SECRET = 'unit-test-secret-0123456789';

test('sign/verify round-trip (node and web-crypto variants agree)', async () => {
  const signed = signSiteHeader('s_abcdefghij', SECRET);
  assert.match(signed, /^s_abcdefghij\.[0-9a-f]{64}$/);
  assert.equal(verifySiteHeader(signed, SECRET), 's_abcdefghij');
  assert.equal(await signSiteHeaderWebCrypto('s_abcdefghij', SECRET), signed);
  assert.equal(await signSiteHeaderWebCrypto('s_abcdefghij', SECRET), signed); // cached path
  assert.equal(verifySiteHeader(signSiteHeader('default', SECRET), SECRET), 'default');
});

test('tampered id or mac -> null', () => {
  const signed = signSiteHeader('s_abcdefghij', SECRET);
  const [id, mac] = signed.split('.');
  assert.equal(verifySiteHeader(`s_abcdefghik.${mac}`, SECRET), null);
  assert.equal(verifySiteHeader(`${id}.${mac.slice(0, -1)}0`, SECRET), null);
  assert.equal(verifySiteHeader(`${id}.${mac.slice(0, -1)}`, SECRET), null);
  assert.equal(verifySiteHeader(signed, 'other-secret'), null);
  assert.equal(verifySiteHeader(`default.${mac}`, SECRET), null);
});

test('invalid formats -> null', () => {
  assert.equal(verifySiteHeader('s_abcdefghij', SECRET), null);
  assert.equal(verifySiteHeader('', SECRET), null);
  assert.equal(verifySiteHeader('.abc', SECRET), null);
  assert.equal(verifySiteHeader('sites.' + 'a'.repeat(64), SECRET), null);
  assert.equal(verifySiteHeader('s_ABCDEFGHIJ.' + 'a'.repeat(64), SECRET), null);
  assert.equal(verifySiteHeader('x'.repeat(300), SECRET), null);
  assert.equal(verifySiteHeader(undefined as unknown as string, SECRET), null);
});

test('signing rejects invalid ids', async () => {
  assert.throws(() => signSiteHeader('nope', SECRET));
  await assert.rejects(signSiteHeaderWebCrypto('nope', SECRET));
});

test('verify uses getSessionSecret() by default', () => {
  const saved = process.env.PAGE_AUTH_SECRET;
  process.env.PAGE_AUTH_SECRET = SECRET;
  try {
    assert.equal(verifySiteHeader(signSiteHeader('s_0123456789', SECRET)), 's_0123456789');
    assert.equal(verifySiteHeader(signSiteHeader('s_0123456789', 'another')), null);
  } finally {
    if (saved === undefined) delete process.env.PAGE_AUTH_SECRET; else process.env.PAGE_AUTH_SECRET = saved;
  }
});
