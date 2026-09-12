import { getKnexClient } from '@/lib/knex-client';
import type {
  WebflowImport,
  WebflowImportPayload,
  WebflowImportResult,
  WebflowImportStatus,
} from '@/types/webwow';

export interface CreateWebflowImportData {
  payload: WebflowImportPayload;
}

export async function createWebflowImport(
  data: CreateWebflowImportData
): Promise<WebflowImport> {
  const db = await getKnexClient();

  const [result] = await db('webflow_imports')
    .insert({
      status: 'pending',
      payload: JSON.stringify(data.payload),
      warnings: JSON.stringify([]),
      errors: JSON.stringify([]),
      result: null,
    })
    .returning('*');

  return result;
}

export async function getWebflowImportById(id: string): Promise<WebflowImport | null> {
  const db = await getKnexClient();

  const result = await db('webflow_imports')
    .select('*')
    .where('id', id)
    .first();

  return result || null;
}

export async function getPendingWebflowImports(limit: number = 1): Promise<WebflowImport[]> {
  const db = await getKnexClient();

  return db('webflow_imports')
    .select('*')
    .whereIn('status', ['pending', 'processing'])
    .orderBy('created_at', 'asc')
    .limit(limit);
}

export async function updateWebflowImportStatus(
  id: string,
  status: WebflowImportStatus
): Promise<void> {
  const db = await getKnexClient();

  await db('webflow_imports')
    .where('id', id)
    .update({
      status,
      updated_at: new Date().toISOString(),
    });
}

export async function completeWebflowImport(
  id: string,
  result: WebflowImportResult,
  warnings: string[],
  errors: string[]
): Promise<void> {
  const db = await getKnexClient();

  await db('webflow_imports')
    .where('id', id)
    .update({
      status: errors.length > 0 ? 'failed' : 'completed',
      result: JSON.stringify(result),
      warnings: JSON.stringify(warnings),
      errors: JSON.stringify(errors),
      updated_at: new Date().toISOString(),
    });
}

export async function updateWebflowImportProgress(
  id: string,
  warnings: string[],
  errors: string[]
): Promise<void> {
  const db = await getKnexClient();

  await db('webflow_imports')
    .where('id', id)
    .update({
      warnings: JSON.stringify(warnings),
      errors: JSON.stringify(errors),
      updated_at: new Date().toISOString(),
    });
}
