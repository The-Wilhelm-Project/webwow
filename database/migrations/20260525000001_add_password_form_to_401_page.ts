import type { Knex } from 'knex';
import type { Layer } from '@/types';
import { generatePageLayersHash } from '@/lib/hash-utils';
import { hasPasswordFormLayer } from '@/lib/layer-utils';
import { buildPasswordFormSubtree } from '@/lib/password-form-template';

/**
 * Migration: Add password form layers to existing 401 error pages
 *
 * Earlier installs seeded the 401 system page with a non-editable hardcoded
 * password form (appended to the rendered output). The 401 page tree itself
 * contained only heading + description text. The renderer now expects an
 * editable form layer with `settings.form.form_type === 'password_protected'`
 * on the 401 page so users can restyle the input/button in the builder canvas.
 *
 * This migration injects the form/input/error-alert/submit-button subtree into
 * existing 401 pages (both draft + published page_layers rows). It is idempotent:
 * pages that already contain a password-protected form are skipped.
 */

/**
 * Pick the deepest single-child flex container with `justifyContent: 'center'`
 * (matches the default 401 template's centred container). Falls back to the
 * 'body' layer if no such container is found so we always have a parent.
 */
function pickInsertionTarget(layers: Layer[]): Layer | null {
  let best: Layer | null = null;

  const walk = (nodes: Layer[]) => {
    for (const node of nodes) {
      const layout = (node.design as any)?.layout;
      const isCenteredFlex = layout?.display === 'Flex'
        && (layout?.justifyContent === 'center' || layout?.alignItems === 'center');
      if (isCenteredFlex) {
        best = node;
      }
      if (node.children) walk(node.children);
    }
  };
  walk(layers);

  if (best) return best;

  // Fallback: append directly under body
  const body = layers.find(l => l.id === 'body' || l.name === 'body');
  return body ?? null;
}

function injectPasswordForm(layers: Layer[]): Layer[] {
  if (hasPasswordFormLayer(layers)) return layers;

  // Deep clone so we don't mutate the input
  const cloned: Layer[] = JSON.parse(JSON.stringify(layers));
  const target = pickInsertionTarget(cloned);
  if (!target) return cloned;

  target.children = target.children || [];
  target.children.push(buildPasswordFormSubtree());
  return cloned;
}

export async function up(knex: Knex): Promise<void> {
  const hasPagesTable = await knex.schema.hasTable('pages');
  const hasPageLayersTable = await knex.schema.hasTable('page_layers');
  if (!hasPagesTable || !hasPageLayersTable) return;

  // Only target 401 system pages (both draft + published rows).
  const errorPages: Array<{ id: string }> = await knex('pages')
    .where({ error_page: 401 })
    .whereNull('deleted_at')
    .select('id');

  if (errorPages.length === 0) return;

  for (const page of errorPages) {
    const layerRows: Array<{ id: string; layers: any; generated_css: string | null; is_published: boolean }> =
      await knex('page_layers')
        .where({ page_id: page.id })
        .whereNull('deleted_at')
        .select('id', 'layers', 'generated_css', 'is_published');

    for (const row of layerRows) {
      let layers: Layer[];
      try {
        layers = typeof row.layers === 'string' ? JSON.parse(row.layers) : (row.layers as Layer[]);
      } catch {
        continue;
      }
      if (!Array.isArray(layers)) continue;

      if (hasPasswordFormLayer(layers)) continue; // idempotent — skip already-migrated

      const updated = injectPasswordForm(layers);
      const contentHash = generatePageLayersHash({
        layers: updated,
        generated_css: row.generated_css,
      });

      await knex('page_layers')
        .where({ id: row.id, is_published: row.is_published })
        .update({
          layers: JSON.stringify(updated),
          content_hash: contentHash,
          updated_at: knex.fn.now(),
        });
    }
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Reversing this migration would risk wiping user customisations on top of
  // the injected form layers. Treat as forward-only.
}
