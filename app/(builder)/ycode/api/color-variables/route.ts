import { NextRequest } from 'next/server';
import {
  getAllColorVariables,
  createColorVariable,
} from '@/lib/repositories/colorVariableRepository';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/color-variables
 */
export async function GET() {
  try {
    const variables = await getAllColorVariables();

    return noCache({ data: variables });
  } catch (error) {
    console.error('[GET /ycode/api/color-variables] Error:', error);

    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch color variables' },
      500
    );
  }
}

/**
 * POST /ycode/api/color-variables
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, value } = body;

    if (!name || !value) {
      return noCache(
        { error: 'Name and value are required' },
        400
      );
    }

    const variable = await createColorVariable({ name, value });

    return noCache({ data: variable });
  } catch (error) {
    console.error('[POST /ycode/api/color-variables] Error:', error);

    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to create color variable' },
      500
    );
  }
}
