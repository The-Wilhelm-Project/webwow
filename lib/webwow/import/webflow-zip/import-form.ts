/**
 * The import dialog's pure half (`components/project/WebflowImportDialog.tsx`):
 * the source summary shown before the import starts and the multipart body
 * sent to `POST /ycode/api/webwow/webflow/import`. Kept apart from the React
 * component so the field order can be unit-tested without a DOM.
 */

export interface ImportSourcesInput {
  hasZip: boolean;
  websiteUrl: string;
  csvCount: number;
  useDataApi: boolean;
  downloadRemoteAssets: boolean;
}

/**
 * What the import will use — the order of the CMS sources is the importer's
 * precedence: API > CSV > Website (the website only ever adds).
 */
export function describeSources(input: ImportSourcesInput): { design: string; cms: string; images: string } {
  const cms: string[] = [];
  if (input.useDataApi) cms.push('API');
  if (input.csvCount > 0) cms.push(`CSV (${input.csvCount})`);
  if (input.websiteUrl.trim()) cms.push('Website');
  const images: string[] = [];
  if (input.websiteUrl.trim()) images.push('Website');
  if (input.downloadRemoteAssets) images.push('CDN');
  images.push('Export');
  return {
    design: input.hasZip ? 'ZIP' : '—',
    cms: cms.length > 0 ? cms.join(' + ') : 'keine',
    images: images.join(' / '),
  };
}

export interface ImportFormInput {
  zipFile: Blob;
  csvFiles: Blob[];
  websiteUrl: string;
  downloadRemoteAssets: boolean;
  suffixSlugConflicts: boolean;
  useDataApi: boolean;
  apiToken: string;
  apiSiteId: string;
  /** Widget switch -> on; only switched-off widgets are sent. */
  widgets: Record<string, boolean>;
}

/** The multipart fields the dialog posts, in the order of the dialog (website, ZIP, CSVs, advanced). */
export function buildImportFormData(input: ImportFormInput): FormData {
  const formData = new FormData();
  if (input.websiteUrl.trim()) formData.append('websiteUrl', input.websiteUrl.trim());
  formData.append('webflowZip', input.zipFile);
  for (const csvFile of input.csvFiles) formData.append('csvFiles', csvFile);
  formData.append('remoteAssets', input.downloadRemoteAssets ? 'download' : 'skip');
  formData.append('pageSlugConflict', input.suffixSlugConflicts ? 'suffix' : 'fail');
  if (input.useDataApi && input.apiToken.trim()) {
    formData.append('webflowApiToken', input.apiToken.trim());
    if (input.apiSiteId.trim()) formData.append('webflowSiteId', input.apiSiteId.trim());
  }
  const disabled = Object.fromEntries(Object.entries(input.widgets).filter(([, on]) => !on));
  if (Object.keys(disabled).length > 0) formData.append('widgets', JSON.stringify(disabled));
  return formData;
}
