import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

// zip.ts imports `@/lib/webwow/storage` (normalizeObjectPath), which carries `import 'server-only'`.
{
  const filename = require.resolve('server-only');
  const mod = new Module(filename) as Module & { loaded: boolean };
  mod.filename = filename;
  mod.loaded = true;
  mod.exports = {};
  require.cache[filename] = mod;
}

import { Warnings } from './warnings';
import { WfImportError } from './types';
import { ZIP_LIMITS, isFontPath, isImagePath, isVideoPath, openWebflowZip } from './zip';

async function fixture(files: Record<string, string | Buffer>, options: JSZip.JSZipGeneratorOptions<'nodebuffer'> = {}): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', ...options });
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WfImportError, `expected WfImportError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('strips the single root folder and classifies pages, css, js, assets and MISSING.txt', async () => {
  const warn = new Warnings();
  const buf = await fixture({
    'site.webflow/index.html': '<html><body>home</body></html>',
    'site.webflow/work.html': '<html><body>work</body></html>',
    'site.webflow/401.html': '<html>401</html>',
    'site.webflow/404.html': '<html>404</html>',
    'site.webflow/css/normalize.css': 'html{margin:0}',
    'site.webflow/css/components.css': '.w-nav{position:relative}',
    'site.webflow/css/site.css': '.a{color:red}',
    'site.webflow/js/site.js': 'Webflow.require("ix2").init({})',
    'site.webflow/images/a.jpg': Buffer.from([0xff, 0xd8, 0xff]),
    'site.webflow/images/a-p-500.jpg': Buffer.from([0xff, 0xd8]),
    'site.webflow/fonts/f.woff2': Buffer.from('wOF2'),
    'site.webflow/videos/v.mp4': Buffer.from('mp4'),
    'site.webflow/documents/d.pdf': Buffer.from('%PDF'),
    'site.webflow/MISSING.txt': 'The following files failed to download during site export.\n\nvideos/x.mov\nvideos/x_webm.webm\n',
    'site.webflow/.DS_Store': Buffer.from([0]),
    '__MACOSX/site.webflow/._index.html': Buffer.from([0]),
  });
  const bundle = await openWebflowZip(buf, { warn });
  assert.equal(bundle.root, 'site.webflow/');
  assert.deepEqual([...bundle.pages.keys()].sort(), ['index', 'work']);
  assert.deepEqual([...bundle.errorPages.keys()].sort(), ['401', '404']);
  assert.equal(bundle.css.normalize?.path, 'css/normalize.css');
  assert.equal(bundle.css.components?.path, 'css/components.css');
  assert.deepEqual(bundle.css.site.map((f) => f.path), ['css/site.css']);
  assert.deepEqual(bundle.js.map((f) => f.path), ['js/site.js']);
  assert.deepEqual([...bundle.files.keys()].sort(), ['documents/d.pdf', 'fonts/f.woff2', 'images/a-p-500.jpg', 'images/a.jpg', 'videos/v.mp4']);
  assert.deepEqual(bundle.missing, ['videos/x.mov', 'videos/x_webm.webm']);
  assert.deepEqual(bundle.skipped.map((s) => s.path).sort(), ['__MACOSX/site.webflow/._index.html', 'site.webflow/.DS_Store']);
  assert.equal(warn.list.length, 0);

  const index = bundle.pages.get('index')!;
  assert.equal(index.path, 'index.html');
  assert.equal(index.size, Buffer.byteLength('<html><body>home</body></html>'));
  assert.equal(await index.text(), '<html><body>home</body></html>');
  const image = bundle.files.get('images/a.jpg')!;
  assert.equal(image.size, 3);
  const data = await image.data();
  assert.deepEqual([...data], [0xff, 0xd8, 0xff]);
  assert.equal(await image.data(), data, 'entry reads are memoised');
});

test('entries at the root keep an empty root prefix; a lone asset folder is not treated as root', async () => {
  const flat = await openWebflowZip(await fixture({ 'index.html': '<html></html>', 'css/site.css': '.a{}' }));
  assert.equal(flat.root, '');
  assert.ok(flat.pages.has('index'));
  const assetsOnly = await openWebflowZip(await fixture({ 'images/a.jpg': 'x', 'images/b.jpg': 'y' }));
  assert.equal(assetsOnly.root, '');
  assert.ok(assetsOnly.files.has('images/a.jpg'));
});

test('a BOM in a text entry is stripped', async () => {
  const bundle = await openWebflowZip(await fixture({ 'css/site.css': '﻿.a{color:red}' }));
  assert.equal(await bundle.css.site[0].text(), '.a{color:red}');
});

test('an oversized entry is rejected before any other work', async () => {
  const buf = await fixture({ 'index.html': 'x'.repeat(100), 'small.txt': 'ok' });
  await rejectsWithCode(openWebflowZip(buf, { limits: { maxEntryBytes: 64 } }), 'zip_entry_too_large');
  await rejectsWithCode(openWebflowZip(buf, { limits: { maxTotalBytes: 50 } }), 'zip_too_large');
  await rejectsWithCode(openWebflowZip(buf, { limits: { maxUploadBytes: 10 } }), 'zip_too_large');
});

test('traversing and invalid entry names never reach the bundle', async () => {
  // JSZip normalises names on `file()`, so the bad names are patched into the
  // generated bytes (same length, so every offset in the archive stays valid).
  const generated = await fixture({ 'xx/evil.txt': 'pwned', 'yy/nul.txt': 'nul', 'index.html': '<html></html>' });
  const patched = Buffer.from(
    generated.toString('latin1').split('xx/evil.txt').join('../evil.txt').split('yy/nul.txt').join('nul.txt\u0000ab'),
    'latin1',
  );
  const warn = new Warnings();
  const bundle = await openWebflowZip(patched, { warn });
  assert.ok(bundle.pages.has('index'));
  const keys = [...bundle.files.keys()];
  // `../evil.txt` is already sanitised by JSZip (>= 3.8, zip-slip fix) to a root-level `evil.txt`.
  assert.ok(!keys.some((p) => p.includes('..')), keys.join(','));
  // A NUL byte survives JSZip and trips our own `normalizeObjectPath` guard.
  assert.ok(!keys.some((p) => p.includes('nul')), keys.join(','));
  assert.equal(warn.count('zip_entry_skipped'), 1);
  assert.ok(bundle.skipped.some((s) => s.path.startsWith('nul.txt') && s.reason.includes('invalid')));
});

test('too many entries and zip bombs are rejected', async () => {
  const many = await fixture({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' });
  await rejectsWithCode(openWebflowZip(many, { limits: { maxEntries: 2 } }), 'zip_entries');
  const bomb = await fixture({ 'index.html': Buffer.alloc(2 ** 20, 0) }, { compression: 'DEFLATE' });
  await rejectsWithCode(openWebflowZip(bomb, { limits: { maxRatio: 10 } }), 'zip_ratio');
  await openWebflowZip(bomb, { limits: { maxRatio: 100_000 } });
});

test('garbage is reported as an invalid ZIP', async () => {
  await rejectsWithCode(openWebflowZip(Buffer.from('this is not a zip file')), 'zip_invalid');
});

test('default limits and path classifiers', () => {
  assert.deepEqual(ZIP_LIMITS, { maxUploadBytes: 200 * 2 ** 20, maxEntryBytes: 100 * 2 ** 20, maxTotalBytes: 2 ** 30, maxEntries: 20_000, maxRatio: 200 });
  assert.ok(isImagePath('images/a.JPG'));
  assert.ok(isImagePath('images/a.svg?v=1'));
  assert.ok(isImagePath('a.webp'));
  assert.ok(!isImagePath('videos/a.mp4'));
  assert.ok(isVideoPath('videos/natur_mp4.mp4'));
  assert.ok(isVideoPath('videos/x.webm#t'));
  assert.ok(!isVideoPath('images/x.png'));
  assert.ok(isFontPath('fonts/NeueHaasDisplayLight.ttf'));
  assert.ok(isFontPath('x.woff2'));
  assert.ok(!isFontPath('x.css'));
});

const SAMPLE_ZIP = path.join(process.cwd(), 'import/web/valeska-von-brase.webflow.zip');

test('the sample export opens with 7 pages, one site sheet, framework sheets, one script and 4 missing files', { skip: !existsSync(SAMPLE_ZIP) }, async () => {
  const warn = new Warnings();
  const bundle = await openWebflowZip(readFileSync(SAMPLE_ZIP), { warn });
  assert.equal(bundle.root, '');
  assert.deepEqual([...bundle.pages.keys()].sort(), ['artist', 'catalog', 'detail_exhibitions', 'detail_werke', 'exhibitions', 'index', 'work']);
  assert.equal(bundle.errorPages.size, 0);
  assert.deepEqual(bundle.css.site.map((f) => f.path), ['css/valeska-von-brase.css']);
  assert.equal(bundle.css.components?.path, 'css/components.css');
  assert.equal(bundle.css.normalize?.path, 'css/normalize.css');
  assert.deepEqual(bundle.js.map((f) => f.path), ['js/valeska-von-brase.js']);
  assert.equal(bundle.missing.length, 4);
  assert.ok(bundle.missing.every((m) => m.startsWith('videos/')));
  const keys = [...bundle.files.keys()];
  assert.ok(keys.filter(isImagePath).length >= 58, `${keys.filter(isImagePath).length} images`);
  assert.equal(keys.filter(isFontPath).length, 3);
  assert.ok(keys.filter(isVideoPath).length >= 3);
  assert.equal(warn.count('zip_entry_skipped'), 0);
  const css = await bundle.css.site[0].text();
  assert.ok(css.startsWith('@font-face'));
});
