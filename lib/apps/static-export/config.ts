/**
 * Static export — configuration + persisted-job status.
 *
 * Read/write is backed by app_settings so config (and the last-job blob)
 * survive across serverless isolates and dev-server restarts.
 */

import { getAppSettingValue, setAppSetting } from '@/lib/repositories/appSettingsRepository'

import type { ExportConfig, ExportJob, OutputTarget } from './types'

export const APP_ID = 'static-export'

const DEFAULT_CONFIG: ExportConfig = {
  outputTargets: ['local'],
  localPath: './out',
  s3Bucket: '',
  s3Region: '',
  s3AccessKey: '',
  s3SecretKey: '',
  githubRepo: '',
  githubBranch: 'main',
  githubToken: '',
  githubAuthorName: '',
  githubAuthorEmail: '',
}

/**
 * Legacy → multi-select migration helper.
 * The pre-multi-select schema stored `output_target` as a single string
 * ('local' | 's3' | 'both'). Translate that into the array shape so
 * anyone who saved settings under the old draft schema isn't blocked.
 */
function migrateLegacyTarget(value: unknown): OutputTarget[] | null {
  if (typeof value !== 'string') return null
  if (value === 'local' || value === 's3') return [value]
  if (value === 'both') return ['local', 's3']
  return null
}

function normalizeOutputTargets(value: unknown): OutputTarget[] {
  if (Array.isArray(value)) {
    const allowed: OutputTarget[] = ['local', 's3', 'github']
    return value.filter((v): v is OutputTarget => allowed.includes(v as OutputTarget))
  }
  return migrateLegacyTarget(value) ?? []
}

export async function getExportConfig(): Promise<ExportConfig> {
  const [
    outputTargetsRaw,
    localPath,
    s3Bucket,
    s3Region,
    s3AccessKey,
    s3SecretKey,
    githubRepo,
    githubBranch,
    githubToken,
    githubAuthorName,
    githubAuthorEmail,
    legacyTarget,
  ] = await Promise.all([
    getAppSettingValue<unknown>(APP_ID, 'output_targets'),
    getAppSettingValue<string>(APP_ID, 'local_path'),
    getAppSettingValue<string>(APP_ID, 's3_bucket'),
    getAppSettingValue<string>(APP_ID, 's3_region'),
    getAppSettingValue<string>(APP_ID, 's3_access_key'),
    getAppSettingValue<string>(APP_ID, 's3_secret_key'),
    getAppSettingValue<string>(APP_ID, 'github_repo'),
    getAppSettingValue<string>(APP_ID, 'github_branch'),
    getAppSettingValue<string>(APP_ID, 'github_token'),
    getAppSettingValue<string>(APP_ID, 'github_author_name'),
    getAppSettingValue<string>(APP_ID, 'github_author_email'),
    getAppSettingValue<unknown>(APP_ID, 'output_target'),
  ])

  // Prefer the new multi-select key; fall back to migrating the old single-value key.
  const outputTargets = normalizeOutputTargets(outputTargetsRaw ?? legacyTarget)

  return {
    outputTargets: outputTargets.length > 0 ? outputTargets : DEFAULT_CONFIG.outputTargets,
    localPath: localPath ?? DEFAULT_CONFIG.localPath,
    s3Bucket: s3Bucket ?? DEFAULT_CONFIG.s3Bucket,
    s3Region: s3Region ?? DEFAULT_CONFIG.s3Region,
    s3AccessKey: s3AccessKey ?? DEFAULT_CONFIG.s3AccessKey,
    s3SecretKey: s3SecretKey ?? DEFAULT_CONFIG.s3SecretKey,
    githubRepo: githubRepo ?? DEFAULT_CONFIG.githubRepo,
    githubBranch: githubBranch ?? DEFAULT_CONFIG.githubBranch,
    githubToken: githubToken ?? DEFAULT_CONFIG.githubToken,
    githubAuthorName: githubAuthorName ?? DEFAULT_CONFIG.githubAuthorName,
    githubAuthorEmail: githubAuthorEmail ?? DEFAULT_CONFIG.githubAuthorEmail,
  }
}

export async function saveExportConfig(config: ExportConfig): Promise<void> {
  await Promise.all([
    setAppSetting(APP_ID, 'output_targets', normalizeOutputTargets(config.outputTargets)),
    setAppSetting(APP_ID, 'local_path', config.localPath),
    setAppSetting(APP_ID, 's3_bucket', config.s3Bucket),
    setAppSetting(APP_ID, 's3_region', config.s3Region),
    setAppSetting(APP_ID, 's3_access_key', config.s3AccessKey),
    setAppSetting(APP_ID, 's3_secret_key', config.s3SecretKey),
    setAppSetting(APP_ID, 'github_repo', config.githubRepo),
    setAppSetting(APP_ID, 'github_branch', config.githubBranch),
    setAppSetting(APP_ID, 'github_token', config.githubToken),
    setAppSetting(APP_ID, 'github_author_name', config.githubAuthorName),
    setAppSetting(APP_ID, 'github_author_email', config.githubAuthorEmail),
  ])
}

/**
 * Persisted last-job status — survives across serverless isolates and
 * dev-server restarts. A module-scope variable would not.
 */
const LAST_JOB_KEY = 'last_export_job'

export async function getLastExportJob(): Promise<ExportJob | null> {
  const value = await getAppSettingValue<ExportJob>(APP_ID, LAST_JOB_KEY)
  return value ?? null
}

export async function saveLastExportJob(job: ExportJob): Promise<void> {
  await setAppSetting(APP_ID, LAST_JOB_KEY, job)
}
