/**
 * Static HTML Export — public entry point.
 *
 * Exports every published Ycode page to standalone HTML using the same
 * fetch + render pipeline as the live site. Output is written to one or
 * more configured targets: local filesystem, S3 bucket, or GitHub repo.
 *
 * The implementation is split across sibling files:
 *   - config.ts          — getExportConfig / saveExportConfig / last-job
 *   - document.ts        — buildDocument + boot scripts
 *   - resolver.ts        — page → route resolution
 *   - paths.ts           — output-key layout (S3-friendly clean URLs)
 *   - asset-bundler.ts   — bundle /public + Supabase-hosted assets
 *   - writers/*.ts       — local / s3 / github
 *   - engine.ts          — orchestration (exportSite)
 */

export { APP_ID, getExportConfig, saveExportConfig, getLastExportJob, saveLastExportJob } from './config'
export { exportSite } from './engine'
export { computeOutputKey } from './paths'
