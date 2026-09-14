import { NextRequest, NextResponse } from 'next/server';
import {
  convertWebflowToProjectExport,
} from '@/lib/services/webflowImportService';
import {
  getExportFilename,
  packExport,
  sanitizeProjectNameSlug,
} from '@/lib/services/projectService';
import type { WebflowCsvFile, WebflowImportPayload } from '@/types/webwow';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

interface ConvertWebflowRequestPayload extends WebflowImportPayload {
  password?: string;
  projectName?: string;
}

function ensureCsvFiles(value: unknown): WebflowCsvFile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((csvFile): csvFile is WebflowCsvFile => (
    typeof csvFile?.filename === 'string'
    && typeof csvFile?.content === 'string'
  ));
}

async function parsePayload(
  request: NextRequest
): Promise<{ payload: WebflowImportPayload; password?: string; projectName?: string }> {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const body: Partial<ConvertWebflowRequestPayload> = await request.json();
    if (!body?.zipBase64 || !body?.zipFilename) {
      throw new Error('Invalid JSON payload: zipFilename and zipBase64 are required');
    }

    const payload: WebflowImportPayload = {
      zipFilename: String(body.zipFilename),
      zipBase64: String(body.zipBase64),
      csvFiles: ensureCsvFiles(body.csvFiles),
    };

    return {
      payload,
      password: typeof body.password === 'string' ? body.password : undefined,
      projectName: typeof body.projectName === 'string' ? body.projectName : undefined,
    };
  }

  const formData = await request.formData();
  const zipFile = formData.get('webflowZip');
  const csvFilesRaw = formData.getAll('csvFiles');
  const password = formData.get('password');
  const projectName = formData.get('projectName');

  if (!zipFile || !(zipFile instanceof Blob)) {
    throw new Error('webflowZip is required');
  }

  const zipFilename = zipFile instanceof File ? zipFile.name : 'webflow-export.zip';
  const zipBuffer = Buffer.from(await zipFile.arrayBuffer());
  const csvFiles: WebflowCsvFile[] = [];

  for (const csvFile of csvFilesRaw) {
    if (!(csvFile instanceof Blob)) {
      continue;
    }
    const filename = csvFile instanceof File
      ? csvFile.name
      : `collection-${csvFiles.length + 1}.csv`;
    const content = await csvFile.text();
    csvFiles.push({ filename, content });
  }

  return {
    payload: {
      zipFilename,
      zipBase64: zipBuffer.toString('base64'),
      csvFiles,
    },
    password: typeof password === 'string' ? password : undefined,
    projectName: typeof projectName === 'string' ? projectName : undefined,
  };
}

/**
 * POST /ycode/api/webflow/convert
 *
 * Webwow-only. Converts a Webflow export payload into a downloadable `.ycode`
 * file (including the asset binaries). The resulting file can be imported via
 * `/ycode/api/project/import`.
 */
export async function POST(request: NextRequest) {
  try {
    const { payload, password, projectName } = await parsePayload(request);
    const conversion = await convertWebflowToProjectExport(payload);

    if (!conversion.success || !conversion.exportData) {
      return NextResponse.json(
        {
          error: conversion.errors[0] || 'Webflow conversion failed',
          warnings: conversion.warnings,
          errors: conversion.errors,
        },
        { status: 400 }
      );
    }

    if (projectName && projectName.trim()) {
      conversion.exportData.manifest.projectName = sanitizeProjectNameSlug(
        projectName.trim()
      );
    }

    const fileBuffer = packExport(conversion.exportData, password || undefined);
    const filename = getExportFilename(conversion.exportData.manifest);

    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[POST /ycode/api/webflow/convert] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to convert Webflow export' },
      { status: 500 }
    );
  }
}
