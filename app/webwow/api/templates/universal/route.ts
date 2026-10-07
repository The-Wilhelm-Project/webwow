import { NextRequest } from 'next/server';
import { applyUniversalTemplate } from '@/lib/services/universalTemplateService';
import { UNIVERSAL_ONTOLOGY } from '@/lib/universal-ontology';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /webwow/api/templates/universal
 * Return the universal ontology definition (collections, fields, relations, pages)
 */
export async function GET() {
  return noCache({ data: UNIVERSAL_ONTOLOGY });
}

/**
 * POST /webwow/api/templates/universal
 * Apply the universal ontology: create collections, sample items, folders and wireframe pages.
 * Body: { withSamples?: boolean; withPages?: boolean }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await applyUniversalTemplate({
      withSamples: body?.withSamples ?? true,
      withPages: body?.withPages ?? true,
    });

    return noCache({ data: result }, 201);
  } catch (error) {
    console.error('Error applying universal template:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to apply universal template' },
      500
    );
  }
}
