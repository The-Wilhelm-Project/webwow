import { NextRequest, NextResponse } from 'next/server';
import { createStyles } from '@/lib/repositories/layerStyleRepository';
import type { CreateLayerStyleData } from '@/lib/repositories/layerStyleRepository';

/**
 * POST /ycode/api/layer-styles/bulk
 * Create many layer styles in a single request.
 *
 * Body: { styles: { name, classes, design?, group? }[] }
 * Returns the created styles in the same order as the request so callers can
 * map results back to their inputs by index.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const styles = Array.isArray(body?.styles) ? body.styles : null;

    if (!styles) {
      return NextResponse.json(
        { error: 'Missing required field: styles[]' },
        { status: 400 }
      );
    }

    for (const style of styles) {
      if (!style?.name || style?.classes === undefined) {
        return NextResponse.json(
          { error: 'Each style requires name and classes' },
          { status: 400 }
        );
      }
    }

    const payload: CreateLayerStyleData[] = styles.map((style: CreateLayerStyleData) => ({
      name: style.name,
      classes: style.classes,
      design: style.design,
      group: style.group,
    }));

    const created = await createStyles(payload);

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    console.error('Error creating layer styles (bulk):', error);
    return NextResponse.json(
      { error: 'Failed to create layer styles' },
      { status: 500 }
    );
  }
}
