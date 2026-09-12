import { NextRequest, NextResponse } from 'next/server';
import { reorderColorVariables } from '@/lib/repositories/colorVariableRepository';

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { orderedIds } = body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return NextResponse.json(
        { error: 'orderedIds array is required' },
        { status: 400 }
      );
    }

    await reorderColorVariables(orderedIds);
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    console.error('Error reordering color variables:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to reorder color variables' },
      { status: 500 }
    );
  }
}
