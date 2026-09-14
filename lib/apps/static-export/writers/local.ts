/**
 * Local-filesystem writer.
 *
 * Writes the output set to a directory on disk. Path is resolved against
 * `process.cwd()` if relative.
 */

import fs from 'fs/promises'
import path from 'path'

import type { ExportConfig } from '../types'
import type { Writer } from './types'

export function createLocalWriter(config: ExportConfig): Writer {
  const basePath = path.isAbsolute(config.localPath)
    ? config.localPath
    : path.resolve(config.localPath)

  return {
    name: 'local',
    async flush(files) {
      for (const f of files) {
        const filePath = path.join(basePath, f.key)
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        const body = typeof f.body === 'string' ? Buffer.from(f.body, 'utf-8') : f.body
        await fs.writeFile(filePath, body)
      }
      return files.length
    },
  }
}
