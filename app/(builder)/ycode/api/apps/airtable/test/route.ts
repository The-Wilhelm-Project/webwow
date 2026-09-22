import { NextRequest } from 'next/server';
import { testToken } from '@/lib/apps/airtable';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/apps/airtable/test
 * Validate an Airtable Personal Access Token
 */
export async function POST(request: NextRequest) {
  try {
    const { api_token } = await request.json();

    if (!api_token || typeof api_token !== 'string') {
      return noCache({ error: 'API token is required' }, 400);
    }

    const result = await testToken(api_token);
    return noCache({ data: result });
  } catch (error) {
    console.error('Error testing Airtable token:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to test token' },
      500
    );
  }
}
