/* eslint-disable @typescript-eslint/no-require-imports */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// storage.ts carries `import 'server-only'`, which throws outside a React server bundle.
{
  const filename = require.resolve('server-only');
  const mod = new Module(filename) as Module & { loaded: boolean };
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = {};
  require.cache[filename] = mod;
}
process.env.PAGE_AUTH_SECRET = 'storage-test-secret';
const uploadDir = path.join(os.tmpdir(), `webwow-storage-test-${process.pid}-${Date.now()}`);
process.env.UPLOAD_DIR = uploadDir;

import { siteStore } from './sites/context';
import {
  createStorageApi,
  getPublicUrl,
  getUploadDir,
  locateObject,
  removeObjects,
  signUploadToken,
  toLogicalPath,
  toPhysicalPath,
  verifyUploadToken,
  writeObject,
} from './storage';

const S1 = 's_1000000000';
const S2 = 's_2000000000';

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

test('toPhysicalPath / toLogicalPath', () => {
  assert.equal(getUploadDir(), path.resolve(uploadDir));
  assert.equal(toPhysicalPath('default', 'website/a.png'), 'website/a.png');
  assert.equal(toPhysicalPath(S1, 'website/a.png'), `sites/${S1}/website/a.png`);
  assert.equal(toLogicalPath(S1, `sites/${S1}/website/a.png`), 'website/a.png');
  assert.equal(toLogicalPath(S1, 'website/a.png'), 'website/a.png');
  assert.equal(toLogicalPath('default', `sites/${S1}/website/a.png`), `sites/${S1}/website/a.png`);
  assert.throws(() => toPhysicalPath('default', 'sites/x/a.png'), /reserved/);
  assert.throws(() => toPhysicalPath('default', 'sites'), /reserved/);
  assert.throws(() => toPhysicalPath('nope', 'a.png'), /Invalid site id/);
  assert.throws(() => toPhysicalPath('s_ABCDEFGHIJ', 'a.png'), /Invalid site id/);
});

test('getPublicUrl under siteStore.run contains the physical site prefix', () => {
  const storage = createStorageApi();
  const def = storage.from('assets').getPublicUrl('website/a b.png').data.publicUrl;
  assert.equal(def, '/storage/v1/object/public/assets/website/a%20b.png');
  const site = siteStore.run(S1, () => storage.from('assets').getPublicUrl('website/a b.png').data.publicUrl);
  assert.equal(site, `/storage/v1/object/public/assets/sites/${S1}/website/a%20b.png`);
  assert.ok(site.includes(`/assets/sites/${S1}/website/`));
  assert.equal(getPublicUrl('assets', `sites/${S1}/website/a.png`), `/storage/v1/object/public/assets/sites/${S1}/website/a.png`);
});

test('writeObject + locateObject land under UPLOAD_DIR/sites/<id>/<bucket>/ and return logical paths', async () => {
  const written = await siteStore.run(S1, () => writeObject('assets', 'website/one.txt', 'hello', { upsert: true }));
  assert.equal(written.path, 'website/one.txt');
  const file = path.join(uploadDir, 'sites', S1, 'assets', 'website', 'one.txt');
  assert.equal(await fs.readFile(file, 'utf8'), 'hello');
  assert.equal(await exists(path.join(uploadDir, 'assets', 'website', 'one.txt')), false);

  const located = await locateObject('assets', `sites/${S1}/website/one.txt`);
  assert.equal(located?.filePath, file);
  assert.equal(await locateObject('assets', 'website/one.txt'), null, 'default site does not see the site file');

  // explicit siteId and physical input are accepted; physical input is never double-prefixed
  const explicit = await writeObject('assets', 'website/two.txt', 'x', { upsert: true, siteId: S2 });
  assert.equal(explicit.path, 'website/two.txt');
  assert.ok(await exists(path.join(uploadDir, 'sites', S2, 'assets', 'website', 'two.txt')));
  const physical = await writeObject('assets', `sites/${S1}/website/three.txt`, 'y', { upsert: true });
  assert.equal(physical.path, 'website/three.txt');
  assert.ok(await exists(path.join(uploadDir, 'sites', S1, 'assets', 'website', 'three.txt')));
  assert.equal(await exists(path.join(uploadDir, 'sites', S1, 'assets', 'sites')), false);
  await assert.rejects(writeObject('assets', `sites/${S1}/website/x.txt`, 'y', { upsert: true, siteId: S2 }), /another site/);
  await assert.rejects(writeObject('assets', 'sites/foo/x.txt', 'y', { upsert: true }), /reserved/);

  // default site files live in UPLOAD_DIR/<bucket>
  const def = await writeObject('assets', 'website/def.txt', 'd', { upsert: true });
  assert.equal(def.path, 'website/def.txt');
  assert.ok(await exists(path.join(uploadDir, 'assets', 'website', 'def.txt')));
});

test('client API: upload/list/download/exists/info/copy/move/remove are site-scoped with logical paths', async () => {
  const storage = createStorageApi();
  const bucket = storage.from('assets');
  await siteStore.run(S1, async () => {
    const up = await bucket.upload('website/img.png', Buffer.from('png'), { upsert: true });
    assert.deepEqual(up.data, { path: 'website/img.png', id: 'website/img.png', fullPath: 'assets/website/img.png' });
    assert.equal((await bucket.exists('website/img.png')).data, true);
    assert.equal((await bucket.info('website/img.png')).data?.name, 'website/img.png');
    assert.equal(await (await bucket.download('website/img.png')).data?.text(), 'png');
    const list = await bucket.list('website');
    assert.ok(list.data?.some((e) => e.id === 'website/img.png'));
    assert.ok(!list.data?.some((e) => e.name === 'def.txt'), 'does not list default-site files');
    const copied = await bucket.copy('website/img.png', 'website/copy.png');
    assert.equal(copied.data?.path, 'assets/website/copy.png');
    assert.ok(await exists(path.join(uploadDir, 'sites', S1, 'assets', 'website', 'copy.png')));
    await bucket.move('website/copy.png', 'website/moved.png');
    assert.equal((await bucket.exists('website/copy.png')).data, false);
    assert.equal((await bucket.exists('website/moved.png')).data, true);
    const removed = await bucket.remove(['website/moved.png', 'website/missing.png']);
    assert.deepEqual(removed.data, [{ name: 'website/moved.png' }]);
  });
  // the same logical path in the default site is a different object
  assert.equal((await bucket.exists('website/img.png')).data, false);
  const defList = await bucket.list('website');
  assert.ok(defList.data?.some((e) => e.name === 'def.txt'));
  assert.ok(!defList.data?.some((e) => e.name === 'img.png'));
  // removeObjects for the default site cannot reach site files through a reserved path
  assert.deepEqual(await removeObjects('assets', [`sites/${S1}/website/img.png`]), []);
  assert.ok(await exists(path.join(uploadDir, 'sites', S1, 'assets', 'website', 'img.png')));
});

test('default-site emptyBucket/deleteBucket leave UPLOAD_DIR/sites/** intact; site bucket ops are scoped', async () => {
  const storage = createStorageApi();
  await writeObject('assets', 'website/def2.txt', 'd', { upsert: true });
  assert.ok(await exists(path.join(uploadDir, 'assets', 'website', 'def2.txt')));
  const siteFile = path.join(uploadDir, 'sites', S1, 'assets', 'website', 'one.txt');
  assert.ok(await exists(siteFile));

  assert.equal((await storage.emptyBucket('assets')).error, null);
  assert.equal(await exists(path.join(uploadDir, 'assets', 'website', 'def2.txt')), false);
  assert.ok(await exists(siteFile), 'site files survive the default emptyBucket');

  assert.equal((await storage.deleteBucket('assets')).error, null);
  assert.equal(await exists(path.join(uploadDir, 'assets')), false);
  assert.ok(await exists(siteFile), 'site files survive the default deleteBucket');

  await siteStore.run(S2, async () => {
    assert.equal((await storage.emptyBucket('assets')).error, null);
    assert.equal(await exists(path.join(uploadDir, 'sites', S2, 'assets', 'website', 'two.txt')), false);
    assert.equal((await storage.deleteBucket('assets')).error, null);
    assert.equal(await exists(path.join(uploadDir, 'sites', S2, 'assets')), false);
    await storage.createBucket('assets');
    assert.ok(await exists(path.join(uploadDir, 'sites', S2, 'assets')));
  });
  assert.ok(await exists(siteFile), 'other sites are untouched');
});

test('upload tokens carry the site: verifyUploadToken returns siteId + physical path; s_1 token cannot write under s_2', async () => {
  const storage = createStorageApi();
  const presign = await siteStore.run(S1, () => storage.from('assets').createSignedUploadUrl('website/up.txt'));
  assert.equal(presign.data?.path, 'website/up.txt');
  const verified = verifyUploadToken(presign.data!.token);
  assert.deepEqual(verified, { bucket: 'assets', objectPath: `sites/${S1}/website/up.txt`, siteId: S1 });

  // the untouched upload route: writeObject(verified.bucket, verified.objectPath, body, { upsert: true }) — in any context
  const written = await siteStore.run(S2, () => writeObject(verified!.bucket, verified!.objectPath, 'data', { upsert: true }));
  assert.equal(written.path, 'website/up.txt');
  assert.ok(await exists(path.join(uploadDir, 'sites', S1, 'assets', 'website', 'up.txt')));
  assert.equal(await exists(path.join(uploadDir, 'sites', S2, 'assets', 'website', 'up.txt')), false);
  const explicit = await writeObject(verified!.bucket, verified!.objectPath, 'data2', { upsert: true, siteId: verified!.siteId });
  assert.equal(explicit.path, 'website/up.txt');

  // uploadToSignedUrl in another site's context is rejected
  const wrongSite = await siteStore.run(S2, () => storage.from('assets').uploadToSignedUrl('website/up.txt', presign.data!.token, 'x'));
  assert.equal(wrongSite.error?.statusCode, '403');
  const wrongPath = await siteStore.run(S1, () => storage.from('assets').uploadToSignedUrl('website/other.txt', presign.data!.token, 'x'));
  assert.equal(wrongPath.error?.statusCode, '403');
  const ok = await siteStore.run(S1, () => storage.from('assets').uploadToSignedUrl('website/up.txt', presign.data!.token, 'z'));
  assert.deepEqual(ok.data, { path: 'website/up.txt', fullPath: 'assets/website/up.txt' });
  assert.equal(await fs.readFile(path.join(uploadDir, 'sites', S1, 'assets', 'website', 'up.txt'), 'utf8'), 'z');

  // legacy tokens (no `s`) map to the default site; explicit signUploadToken(siteId)
  const legacyPayload = Buffer.from(JSON.stringify({ b: 'assets', p: 'website/legacy.txt', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const { createHmac } = require('node:crypto') as typeof import('node:crypto');
  const legacy = `${legacyPayload}.${createHmac('sha256', process.env.PAGE_AUTH_SECRET!).update(legacyPayload).digest('hex')}`;
  assert.deepEqual(verifyUploadToken(legacy), { bucket: 'assets', objectPath: 'website/legacy.txt', siteId: 'default' });
  assert.equal(verifyUploadToken(signUploadToken('assets', 'website/x.txt', 60, S2))?.siteId, S2);
  assert.equal(verifyUploadToken(signUploadToken('assets', 'website/x.txt', 60))?.siteId, 'default');
  assert.equal(verifyUploadToken(`${legacyPayload}.deadbeef`), null);
  assert.equal(verifyUploadToken(signUploadToken('assets', 'website/x.txt', -1)), null, 'expired');
});

test('cleanup', async () => {
  await fs.rm(uploadDir, { recursive: true, force: true });
});
