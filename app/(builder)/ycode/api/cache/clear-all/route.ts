import { NextRequest, NextResponse } from 'next/server';
import { noCache } from '@/lib/api-response';
import { clearAllCache } from '@/lib/services/cacheService';

/**
 * Vercel Cache Invalidation Endpoint
 * 
 * Handles full cache invalidation (data cache tags + layout path)
 */

export async function POST(request: NextRequest) {
  try {
    await clearAllCache();

    return noCache({
      success: true,
      message: 'All cache invalidated',
    });
  } catch (error) {
    console.error('Cache invalidation error:', error);
    
    return noCache(
      { error: 'Failed to invalidate cache' },
      500
    );
  }
}
