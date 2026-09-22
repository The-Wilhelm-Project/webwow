import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DesignProperties, Layer } from '@/types';
import { getAllStyles, createStyle, updateStyle, deleteStyle } from '@/lib/repositories/layerStyleRepository';
import { getCachedDraft, saveCachedLayers } from '@/lib/mcp/page-layers';
import { findLayerById, updateLayerById, designToClassString } from '@/lib/mcp/utils';
import { applyStyleToLayer, setLayerStyleStack } from '@/lib/layer-style-utils';
import { designSchema } from './shared-schemas';

export function registerStyleTools(server: McpServer) {
  server.tool(
    'list_styles',
    'List all reusable layer styles. Styles define reusable design presets that can be applied to any layer.',
    {},
    async () => {
      const styles = await getAllStyles();
      return { content: [{ type: 'text' as const, text: JSON.stringify(styles) }] };
    },
  );

  server.tool(
    'create_style',
    'Create a reusable layer style — like a CSS class. Define the design once, apply it to any number of layers.',
    {
      name: z.string().describe('Style name (e.g. "Card", "Button Primary")'),
      design: designSchema,
    },
    async ({ name, design }) => {
      const classes = designToClassString(design as DesignProperties);
      const style = await createStyle({ name, classes, design: design as DesignProperties });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: `Created style "${name}"`, style_id: style.id, classes }),
        }],
      };
    },
  );

  server.tool(
    'apply_style',
    'Apply a single reusable layer style to a layer, replacing any existing style stack. To stack multiple styles (combo classes) or control their priority order, use set_layer_styles instead.',
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID to apply the style to'),
      style_id: z.string().describe('The style ID'),
    },
    async ({ page_id, layer_id, style_id }) => {
      const pageLayers = await getCachedDraft(page_id);
      if (!pageLayers) {
        return { content: [{ type: 'text' as const, text: `Error: Page "${page_id}" has no layers.` }], isError: true };
      }

      const layers = pageLayers.layers as Layer[];
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const style = (await getAllStyles()).find((s) => s.id === style_id);
      if (!style) {
        return { content: [{ type: 'text' as const, text: `Error: Style "${style_id}" not found.` }], isError: true };
      }

      // Apply as the layer's style, flattening its classes/design for the render.
      const updated = updateLayerById(layers, layer_id, (l) => applyStyleToLayer(l, style));
      await saveCachedLayers(page_id, updated);

      return { content: [{ type: 'text' as const, text: `Applied style "${style_id}" to "${layer.customName || layer.name}"` }] };
    },
  );

  server.tool(
    'set_layer_styles',
    `Set the ordered stack of reusable styles applied to a layer (combo classes).

Styles are listed low -> high priority — later styles win on conflicting properties,
exactly like Webflow combo classes. This REPLACES the layer's current style stack and
re-flattens the resulting classes. Use this (instead of apply_style) whenever a layer
needs more than one style.

- Apply a single style:        style_ids: ["<card>"]
- Stack base + modifier:       style_ids: ["<button>", "<button-primary>"]
- Reorder priority:            reorder the array (last wins)
- Detach all styles (keep the current look as local classes): style_ids: []`,
    {
      page_id: z.string().describe('The page ID'),
      layer_id: z.string().describe('The layer ID'),
      style_ids: z.array(z.string())
        .describe('Ordered style IDs, low -> high priority (last wins on conflicts). Pass an empty array to detach all styles while keeping the current look.'),
    },
    async ({ page_id, layer_id, style_ids }) => {
      const pageLayers = await getCachedDraft(page_id);
      if (!pageLayers) {
        return { content: [{ type: 'text' as const, text: `Error: Page "${page_id}" has no layers.` }], isError: true };
      }

      const layers = pageLayers.layers as Layer[];
      const layer = findLayerById(layers, layer_id);
      if (!layer) {
        return { content: [{ type: 'text' as const, text: `Error: Layer "${layer_id}" not found.` }], isError: true };
      }

      const stylesById = new Map((await getAllStyles()).map((s) => [s.id, s]));
      const missing = style_ids.filter((id) => !stylesById.has(id));
      if (missing.length > 0) {
        return { content: [{ type: 'text' as const, text: `Error: Style(s) not found: ${missing.join(', ')}` }], isError: true };
      }

      const updated = updateLayerById(layers, layer_id, (l) => setLayerStyleStack(l, style_ids, stylesById));
      await saveCachedLayers(page_id, updated);

      const target = findLayerById(updated, layer_id);
      const label = style_ids.length === 0
        ? `Detached all styles from "${layer.customName || layer.name}"`
        : `Applied style stack [${style_ids.join(', ')}] to "${layer.customName || layer.name}"`;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ message: label, layer_id, style_ids, classes: target?.classes }),
        }],
      };
    },
  );

  server.tool(
    'update_style',
    'Update a reusable layer style — change its name or design properties.',
    {
      style_id: z.string().describe('The style ID to update'),
      name: z.string().optional().describe('New style name'),
      design: designSchema.optional(),
    },
    async ({ style_id, name, design }) => {
      const updates: Record<string, unknown> = {};
      if (name) updates.name = name;
      if (design) {
        updates.design = design;
        updates.classes = designToClassString(design as DesignProperties);
      }
      const style = await updateStyle(style_id, updates);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: `Updated style "${style.name}"`, style }) }] };
    },
  );

  server.tool(
    'delete_style',
    'Delete a reusable layer style. Layers using this style will lose it.',
    { style_id: z.string().describe('The style ID to delete') },
    async ({ style_id }) => {
      await deleteStyle(style_id);
      return { content: [{ type: 'text' as const, text: `Deleted style ${style_id}` }] };
    },
  );
}
