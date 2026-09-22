/**
 * Webwow builder panels: pure helpers shared by the rail panels and the Find palette.
 *
 * No React, no stores - only structural types, so this module is unit-testable with node:test.
 */

export interface LayerLike {
  id: string;
  name: string;
  customName?: string;
  componentId?: string;
  children?: LayerLike[];
}

export interface FlatLayer {
  id: string;
  /** Display name (custom name, block name or the raw layer name). */
  label: string;
  /** Parent chain from the root, e.g. "Body › Section › Container". */
  path: string;
  depth: number;
  /** Raw layer name (`image`, `div`, ...). */
  name: string;
}

/** Display name for a layer, in the order the Navigator uses it. */
export function layerLabel(layer: LayerLike, blockName?: string | null): string {
  if (layer.customName && layer.customName.trim()) return layer.customName.trim();
  if (blockName) return blockName;
  if (layer.id === 'body') return 'Body';
  return layer.name;
}

/**
 * Depth-first flattening of a layer tree for search (Find palette).
 * `blockNameFor` resolves a template block name from a raw layer name (optional).
 */
export function flattenLayers(
  layers: readonly LayerLike[],
  blockNameFor: (name: string) => string | null = () => null,
  limit = 2000,
): FlatLayer[] {
  const out: FlatLayer[] = [];
  const walk = (nodes: readonly LayerLike[], parents: string[], depth: number) => {
    for (const node of nodes) {
      if (out.length >= limit) return;
      const label = layerLabel(node, blockNameFor(node.name));
      out.push({ id: node.id, label, path: parents.join(' › '), depth, name: node.name });
      if (node.children && node.children.length > 0) walk(node.children, [...parents, label], depth + 1);
    }
  };
  walk(layers, [], 0);
  return out;
}

/** Finds a layer by id anywhere in the tree. */
export function findLayerById<T extends LayerLike>(layers: readonly T[], id: string): T | null {
  for (const node of layers) {
    if (node.id === id) return node;
    if (node.children && node.children.length > 0) {
      const found = findLayerById(node.children as T[], id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Match score for the Find palette: 3 = label starts with the query, 2 = a word starts with it,
 * 1 = substring, 0 = no match. Case-insensitive.
 */
export function matchScore(label: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 3;
  if (l.split(/[\s/_-]+/).some((word) => word.startsWith(q))) return 2;
  if (l.includes(q)) return 1;
  return 0;
}

export interface Rankable {
  label: string;
  group: string;
}

/**
 * Ranks entries by score, then by group order, then by original order.
 * At most `perGroup` per group and `total` overall.
 */
export function rankEntries<T extends Rankable>(
  entries: readonly T[],
  query: string,
  groupOrder: readonly string[],
  perGroup = 8,
  total = 40,
): T[] {
  const q = query.trim();
  if (!q) return [];
  const scored = entries
    .map((entry, index) => ({ entry, score: matchScore(entry.label, q), index }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ga = groupOrder.indexOf(a.entry.group);
      const gb = groupOrder.indexOf(b.entry.group);
      if (ga !== gb) return ga - gb;
      return a.index - b.index;
    });
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const { entry } of scored) {
    const n = counts.get(entry.group) ?? 0;
    if (n >= perGroup) continue;
    counts.set(entry.group, n + 1);
    out.push(entry);
    if (out.length >= total) break;
  }
  // Keep group order stable in the result so headings do not interleave.
  return out.sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group));
}

/** "Collection", "Collection 1", "Collection 2", ... - the CMS sidebar's naming rule. */
export function uniqueName(baseName: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(baseName)) return baseName;
  let counter = 1;
  while (taken.has(`${baseName} ${counter}`)) counter++;
  return `${baseName} ${counter}`;
}

/** Parent-chain of asset folders (root first) for a breadcrumb. */
export function folderPath<T extends { id: string; asset_folder_id: string | null; name: string }>(
  folders: readonly T[],
  folderId: string | null,
): T[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: T[] = [];
  let current = folderId ? byId.get(folderId) ?? null : null;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.asset_folder_id ? byId.get(current.asset_folder_id) ?? null : null;
  }
  return path;
}

/** Formats a byte count for the asset grid ("12 KB", "1.4 MB"). */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
