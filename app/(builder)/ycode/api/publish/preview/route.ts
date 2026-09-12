import { NextRequest } from 'next/server';
import { getUnpublishedAssetsCount } from '@/lib/repositories/assetRepository';
import { getTotalPublishableItemsCount } from '@/lib/repositories/collectionItemRepository';
import { getUnpublishedCollectionsCount } from '@/lib/repositories/collectionRepository';
import { getUnpublishedComponentChanges } from '@/lib/repositories/componentRepository';
import { getUnpublishedLayerStylesCount } from '@/lib/repositories/layerStyleRepository';
import { getUnpublishedPageChanges } from '@/lib/repositories/pageRepository';
import { getUnpublishedTranslationsCount } from '@/lib/repositories/translationRepository';
import { getUnpublishedGlobalVariablesCount } from '@/lib/repositories/globalVariableRepository';
import { getDeletedDraftCount } from '@/lib/sync-utils';
import { noCache } from '@/lib/api-response';
import type { UnpublishedChange } from '@/lib/publish-changes';

// Disable caching for this route
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export interface PublishPreviewChanges {
  pages: UnpublishedChange[];
  components: UnpublishedChange[];
}

export interface PublishPreviewCounts {
  pages: number;
  collections: number;
  collectionItems: number;
  components: number;
  layerStyles: number;
  assets: number;
  translations: number;
  globalVariables: number;
  changes: PublishPreviewChanges;
  total: number;
}

/**
 * GET /ycode/api/publish/preview
 * Count all pending changes (new, modified, deleted) per entity type.
 */
export async function GET(_request: NextRequest) {
  try {
    const [
      pageChanges,
      collectionsChanged, collectionsDeleted,
      itemsChanged, itemsDeleted,
      componentChanges,
      layerStylesChanged, layerStylesDeleted,
      assetsChanged, assetsDeleted,
      translationsChanged,
      globalVariablesChanged,
    ] = await Promise.all([
      getUnpublishedPageChanges(),
      getUnpublishedCollectionsCount(),
      getDeletedDraftCount('collections'),
      getTotalPublishableItemsCount(),
      getDeletedDraftCount('collection_items'),
      getUnpublishedComponentChanges(),
      getUnpublishedLayerStylesCount(),
      getDeletedDraftCount('layer_styles'),
      getUnpublishedAssetsCount(),
      getDeletedDraftCount('assets'),
      getUnpublishedTranslationsCount(),
      getUnpublishedGlobalVariablesCount(),
    ]);

    const pages = pageChanges.length;
    const collections = collectionsChanged + collectionsDeleted;
    const collectionItems = itemsChanged + itemsDeleted;
    const components = componentChanges.length;
    const layerStyles = layerStylesChanged + layerStylesDeleted;
    const assets = assetsChanged + assetsDeleted;
    const translations = translationsChanged;
    const globalVariables = globalVariablesChanged;
    const total = pages + collections + collectionItems + components + layerStyles + assets + translations + globalVariables;

    return noCache({
      data: {
        pages,
        collections,
        collectionItems,
        components,
        layerStyles,
        assets,
        translations,
        globalVariables,
        changes: {
          pages: pageChanges,
          components: componentChanges,
        },
        total,
      } satisfies PublishPreviewCounts,
    });
  } catch (error) {
    console.error('Error fetching publish preview:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch publish preview' },
      500
    );
  }
}
