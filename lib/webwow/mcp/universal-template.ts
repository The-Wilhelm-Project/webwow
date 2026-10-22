import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { applyUniversalTemplate } from '@/lib/webwow/templates/universal-template';
import { UNIVERSAL_ONTOLOGY } from '@/lib/webwow/templates/universal-ontology';

/**
 * MCP tools for the universal website ontology (registered in lib/mcp/server.ts).
 * The MCP route runs tool calls in the site of the token, so the template is
 * applied to that site.
 */
export function registerUniversalTemplateTools(server: McpServer) {
  server.tool(
    'get_universal_ontology',
    `Describe the universal website ontology: 12 Schema.org-aligned collections (organizations, people, places, brands, channels, events, articles, works, offerings, jobs, attributes, categories) with their fields, relations, type vocabularies and the static pages the template creates.`,
    {},
    async () => {
      const summary = UNIVERSAL_ONTOLOGY.collections.map((c) => ({
        key: c.key,
        name: c.name,
        schemaOrg: c.schemaOrg,
        aliases: c.aliases,
        folder: c.folderSlug,
        types: c.types,
        fields: c.fields.map((f) => ({ key: f.key, type: f.type, ref: f.ref, role: f.role, hint: f.hint })),
        inverse: c.inverse,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ version: UNIVERSAL_ONTOLOGY.version, collections: summary, pages: UNIVERSAL_ONTOLOGY.pages }, null, 2) }],
      };
    },
  );

  server.tool(
    'apply_universal_template',
    `Apply the universal website ontology to this site: creates all collections with fields and relations, optional sample items, a folder with list + detail page per collection and static wireframe pages (Home, About, Contact, FAQ, Legal). Additive and safe to re-run: existing collections (by name), folders (by slug) and pages are reused, never overwritten. Everything is created as draft.`,
    {
      with_samples: z.boolean().optional().describe('Insert sample items into newly created collections (default true)'),
      with_pages: z.boolean().optional().describe('Create folders, list/detail pages and static pages (default true)'),
    },
    async ({ with_samples, with_pages }) => {
      const result = await applyUniversalTemplate({ withSamples: with_samples ?? true, withPages: with_pages ?? true });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
