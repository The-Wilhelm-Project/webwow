import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildImportFormData, describeSources } from './import-form';

test('describeSources: the summary names every source in precedence order', () => {
  assert.deepEqual(describeSources({ hasZip: false, websiteUrl: '', csvCount: 0, useDataApi: false, downloadRemoteAssets: true }), { design: '—', cms: 'keine', images: 'CDN / Export' });
  assert.deepEqual(describeSources({ hasZip: true, websiteUrl: 'https://www.valeska-von-brase.de', csvCount: 2, useDataApi: false, downloadRemoteAssets: true }), { design: 'ZIP', cms: 'CSV (2) + Website', images: 'Website / CDN / Export' });
  assert.deepEqual(describeSources({ hasZip: true, websiteUrl: ' ', csvCount: 1, useDataApi: true, downloadRemoteAssets: false }), { design: 'ZIP', cms: 'API + CSV (1)', images: 'Export' });
});

test('buildImportFormData: dialog order, optional fields only when set, widgets only when switched off', () => {
  const zip = new Blob(['zip'], { type: 'application/zip' });
  const csv = new Blob(['Name,Slug'], { type: 'text/csv' });
  const form = buildImportFormData({
    zipFile: zip,
    csvFiles: [csv, csv],
    websiteUrl: ' https://www.example.com ',
    downloadRemoteAssets: true,
    suffixSlugConflicts: true,
    useDataApi: true,
    apiToken: ' tok ',
    apiSiteId: '',
    widgets: { slider: true, tabs: false, form: true },
  });
  assert.deepEqual([...form.keys()], ['websiteUrl', 'webflowZip', 'csvFiles', 'csvFiles', 'remoteAssets', 'pageSlugConflict', 'webflowApiToken', 'widgets']);
  assert.equal(form.get('websiteUrl'), 'https://www.example.com');
  assert.equal(form.get('remoteAssets'), 'download');
  assert.equal(form.get('pageSlugConflict'), 'suffix');
  assert.equal(form.get('webflowApiToken'), 'tok');
  assert.equal(form.get('widgets'), '{"tabs":false}');

  const minimal = buildImportFormData({ zipFile: zip, csvFiles: [], websiteUrl: '', downloadRemoteAssets: false, suffixSlugConflicts: false, useDataApi: false, apiToken: 'ignored', apiSiteId: 'ignored', widgets: { slider: true } });
  assert.deepEqual([...minimal.keys()], ['webflowZip', 'remoteAssets', 'pageSlugConflict']);
  assert.equal(minimal.get('remoteAssets'), 'skip');
  assert.equal(minimal.get('pageSlugConflict'), 'fail');
});
