/**
 * S3 (and S3-compatible) writer.
 *
 * Dynamic-imports `@aws-sdk/client-s3` so the AWS SDK stays out of the
 * bundle for users who only export locally. The dependency is listed in
 * `optionalDependencies`, so a missing module is a real misconfiguration
 * for S3-targeted exports — we surface a clear install hint.
 */

import type { ExportConfig } from '../types'
import type { Writer } from './types'

export async function createS3Writer(config: ExportConfig): Promise<Writer> {
  if (!config.s3Bucket || !config.s3Region) {
    throw new Error('S3 export selected but bucket and region are required')
  }
  if (!config.s3AccessKey || !config.s3SecretKey) {
    throw new Error('S3 export selected but access key and secret are required')
  }

  type S3ClientCtor = typeof import('@aws-sdk/client-s3').S3Client
  type PutObjectCmdCtor = typeof import('@aws-sdk/client-s3').PutObjectCommand
  let S3Client: S3ClientCtor
  let PutObjectCommand: PutObjectCmdCtor
  try {
    const aws = await import('@aws-sdk/client-s3')
    S3Client = aws.S3Client
    PutObjectCommand = aws.PutObjectCommand
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Failed to load @aws-sdk/client-s3. Run "npm install @aws-sdk/client-s3" and retry. (${message})`,
    )
  }

  const client = new S3Client({
    region: config.s3Region,
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3SecretKey,
    },
  })

  return {
    name: 's3',
    async flush(files) {
      let written = 0
      for (const f of files) {
        await client.send(
          new PutObjectCommand({
            Bucket: config.s3Bucket,
            Key: f.key,
            Body: f.body,
            ContentType: f.contentType,
            // HTML pages must revalidate so a publish is visible
            // immediately. Hashed asset URLs would use a long max-age.
            CacheControl: 'public, max-age=0, must-revalidate',
          }),
        )
        written++
      }
      return written
    },
  }
}
