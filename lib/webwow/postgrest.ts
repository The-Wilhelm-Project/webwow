/**
 * PostgREST-compatible query builder on top of knex (Webwow compatibility layer).
 *
 * Upstream ycode talks to its database through supabase-js, i.e. through the
 * PostgREST query builder (`client.from('pages').select('*').eq(...)`). Webwow
 * runs on a plain PostgreSQL database, so this module re-implements the subset
 * of that builder that the upstream code base uses and executes it with knex.
 *
 * Supported (see docs/UPSTREAM-SYNC.md for how to extend):
 *  - from(table).select(cols, { count, head }) / insert / upsert / update / delete
 *  - filters: eq, neq, gt, gte, lt, lte, like, ilike, is, in, contains, containedBy,
 *    overlaps, not(col, op, val), or('a.eq.1,b.like.%x%'), match({}), filter(col, op, val)
 *  - modifiers: order, limit, range, single, maybeSingle, throwOnError, abortSignal,
 *    select() after a write (RETURNING)
 *  - embedded resources: `rel!inner(cols)`, `rel!left(cols)`, `rel(cols)` for tables that
 *    are linked by a foreign key (discovered from pg_catalog at runtime), including
 *    filters on embedded columns (`.eq('page_layers.is_published', false)`)
 *  - jsonb columns are serialised like PostgREST does (JS value -> JSON), array columns
 *    (`text[]`) are passed through as PostgreSQL arrays
 *  - result shape `{ data, error, count, status, statusText }`, `single()` -> PGRST116
 *
 * Not supported (throws a PostgREST-style error): `csv()`, `explain()`, range operators,
 * `referencedTable` ordering/limits.
 */

import type { Knex } from 'knex';

export interface PostgrestError {
  message: string;
  code: string;
  details: string | null;
  hint: string | null;
}

export interface PostgrestResponse<T = any> {
  data: T;
  error: PostgrestError | null;
  count: number | null;
  status: number;
  statusText: string;
}

type FilterOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike' | 'is' | 'in'
  | 'cs' | 'cd' | 'ov' | 'fts' | 'plfts' | 'phfts' | 'wfts';

interface Filter {
  kind: 'filter';
  column: string;
  op: FilterOperator;
  value: unknown;
  negate: boolean;
}

interface OrGroup {
  kind: 'or';
  filters: Filter[];
}

type Condition = Filter | OrGroup;

interface OrderSpec {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
  referencedTable?: string;
}

interface EmbeddedRelation {
  /** key used in the result rows (alias or relation name) */
  key: string;
  /** related table name */
  table: string;
  modifier: 'inner' | 'left' | null;
  columns: string[];
}

interface ParsedSelect {
  columns: string[]; // '*' or explicit column names (may contain aliases "alias:col")
  relations: EmbeddedRelation[];
}

interface RelationLink {
  /** 'many' = related rows reference the base table (array), 'one' = base row references related table (object) */
  type: 'many' | 'one';
  baseColumns: string[];
  relatedColumns: string[];
}

/** Marker object produced by `client.rpc('increment', { x })` when used as a value in `.update()`. */
export interface RpcIncrementMarker {
  __webwowRpc: 'increment';
  x: number;
}

export function isRpcIncrementMarker(value: unknown): value is RpcIncrementMarker {
  return !!value && typeof value === 'object' && (value as RpcIncrementMarker).__webwowRpc === 'increment';
}

const OPERATOR_ALIASES: Record<string, FilterOperator> = {
  eq: 'eq', neq: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte',
  like: 'like', ilike: 'ilike', is: 'is', in: 'in',
  cs: 'cs', contains: 'cs', cd: 'cd', containedBy: 'cd', ov: 'ov', overlaps: 'ov',
  fts: 'fts', plfts: 'plfts', phfts: 'phfts', wfts: 'wfts',
};

// ---------------------------------------------------------------------------
// Schema introspection (cached per process)
// ---------------------------------------------------------------------------

interface SchemaCache {
  columnTypes: Map<string, Map<string, string>>;
  primaryKeys: Map<string, string[]>;
  relations: Map<string, RelationLink | null>;
}

const globalForSchema = globalThis as unknown as { __webwowSchemaCache?: SchemaCache };

function getSchemaCache(): SchemaCache {
  if (!globalForSchema.__webwowSchemaCache) {
    globalForSchema.__webwowSchemaCache = {
      columnTypes: new Map(),
      primaryKeys: new Map(),
      relations: new Map(),
    };
  }
  return globalForSchema.__webwowSchemaCache;
}

/** Drop cached schema information (call after running migrations). */
export function resetSchemaCache(): void {
  globalForSchema.__webwowSchemaCache = undefined;
}

async function getColumnTypes(db: Knex, table: string): Promise<Map<string, string>> {
  const cache = getSchemaCache();
  const cached = cache.columnTypes.get(table);
  if (cached) return cached;

  const rows = await db('information_schema.columns')
    .select('column_name', 'data_type', 'udt_name')
    .where({ table_schema: 'public', table_name: table });

  const map = new Map<string, string>();
  for (const row of rows as Array<{ column_name: string; data_type: string; udt_name: string }>) {
    map.set(row.column_name, row.data_type === 'ARRAY' ? 'ARRAY' : row.udt_name);
  }
  cache.columnTypes.set(table, map);
  return map;
}

async function getPrimaryKey(db: Knex, table: string): Promise<string[]> {
  const cache = getSchemaCache();
  const cached = cache.primaryKeys.get(table);
  if (cached) return cached;

  const result = await db.raw(
    `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary AND n.nspname = 'public' AND c.relname = ?
      ORDER BY array_position(i.indkey, a.attnum)`,
    [table],
  );
  const columns = (result.rows as Array<{ column_name: string }>).map((row) => row.column_name);
  cache.primaryKeys.set(table, columns);
  return columns;
}

async function getRelation(db: Knex, baseTable: string, relatedTable: string): Promise<RelationLink | null> {
  const cache = getSchemaCache();
  const key = `${baseTable}->${relatedTable}`;
  if (cache.relations.has(key)) return cache.relations.get(key) ?? null;

  const result = await db.raw(
    `SELECT cl.relname AS child_table, fcl.relname AS parent_table,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)::text[] AS child_cols,
            (SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)::text[] AS parent_cols
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_class fcl ON fcl.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
        AND ((cl.relname = ? AND fcl.relname = ?) OR (cl.relname = ? AND fcl.relname = ?))
      ORDER BY cardinality(c.conkey) DESC`,
    [relatedTable, baseTable, baseTable, relatedTable],
  );

  const toArray = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') return value.replace(/^\{|\}$/g, '').split(',').map((v) => v.replace(/^"|"$/g, '')).filter(Boolean);
    return [];
  };
  const rows = (result.rows as Array<{ child_table: string; parent_table: string; child_cols: unknown; parent_cols: unknown }>)
    .map((row) => ({ ...row, child_cols: toArray(row.child_cols), parent_cols: toArray(row.parent_cols) }));
  let link: RelationLink | null = null;
  for (const row of rows) {
    if (row.child_table === relatedTable && row.parent_table === baseTable) {
      link = { type: 'many', baseColumns: row.parent_cols, relatedColumns: row.child_cols };
      break;
    }
    if (row.child_table === baseTable && row.parent_table === relatedTable) {
      link = { type: 'one', baseColumns: row.child_cols, relatedColumns: row.parent_cols };
      break;
    }
  }
  cache.relations.set(key, link);
  return link;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function splitTopLevel(input: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (const char of input) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseSelect(select: string | undefined): ParsedSelect {
  const raw = (select ?? '*').replace(/\s+/g, ' ').trim();
  if (raw === '' || raw === '*') return { columns: ['*'], relations: [] };

  const columns: string[] = [];
  const relations: EmbeddedRelation[] = [];

  for (const item of splitTopLevel(raw)) {
    const embedded = item.match(/^(?:([A-Za-z0-9_]+):)?([A-Za-z0-9_]+)(?:!(inner|left))?\s*\(([\s\S]*)\)$/);
    if (embedded) {
      const [, alias, table, modifier, cols] = embedded;
      relations.push({
        key: alias || table,
        table,
        modifier: (modifier as 'inner' | 'left' | undefined) ?? null,
        columns: cols.trim() === '' || cols.trim() === '*' ? ['*'] : splitTopLevel(cols).map((c) => c.replace(/"/g, '')),
      });
      continue;
    }
    columns.push(item.replace(/"/g, ''));
  }

  return { columns: columns.length === 0 ? ['*'] : columns, relations };
}

function coerceFilterStringValue(value: string): unknown {
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** Parse the PostgREST filter string syntax used by `.or()` (e.g. `a.eq.1,b.like.%x%`). */
function parseFilterString(input: string): Filter[] {
  const filters: Filter[] = [];
  for (const part of splitTopLevel(input)) {
    const firstDot = part.indexOf('.');
    if (firstDot === -1) throw new Error(`Invalid filter expression: ${part}`);
    const column = part.slice(0, firstDot);
    let rest = part.slice(firstDot + 1);
    let negate = false;
    if (rest.startsWith('not.')) {
      negate = true;
      rest = rest.slice(4);
    }
    const secondDot = rest.indexOf('.');
    if (secondDot === -1) throw new Error(`Invalid filter expression: ${part}`);
    const opName = rest.slice(0, secondDot);
    const rawValue = rest.slice(secondDot + 1);
    const op = OPERATOR_ALIASES[opName];
    if (!op) throw new Error(`Unsupported filter operator: ${opName}`);

    let value: unknown = rawValue;
    if (op === 'in') {
      const inner = rawValue.replace(/^\(/, '').replace(/\)$/, '');
      value = splitTopLevel(inner).map((v) => coerceFilterStringValue(v.replace(/^"(.*)"$/, '$1')));
    } else {
      value = coerceFilterStringValue(rawValue.replace(/^"(.*)"$/, '$1'));
    }
    filters.push({ kind: 'filter', column, op, value, negate });
  }
  return filters;
}

/** Turn a PostgREST column reference (`data->>key`, `"quoted"`) into a knex reference. */
function columnRef(db: Knex, column: string, tableAlias?: string): string | Knex.Raw {
  const clean = column.replace(/"/g, '');
  if (clean.includes('->')) {
    const segments = clean.split(/(->>|->)/);
    let sql = '??';
    const bindings: unknown[] = [tableAlias ? `${tableAlias}.${segments[0]}` : segments[0]];
    for (let i = 1; i < segments.length; i += 2) {
      sql += `${segments[i]}?`;
      bindings.push(segments[i + 1]);
    }
    return db.raw(sql, bindings as Knex.RawBinding[]);
  }
  return tableAlias ? `${tableAlias}.${clean}` : clean;
}

function rowKey(row: Record<string, unknown>, columns: string[]): string {
  return JSON.stringify(columns.map((column) => (row[column] === null || row[column] === undefined ? null : String(row[column]))));
}

// ---------------------------------------------------------------------------
// Serialisation of values for writes
// ---------------------------------------------------------------------------

function serializeValue(db: Knex, columnType: string | undefined, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (isRpcIncrementMarker(value)) return value; // handled by the caller (needs the column name)
  if (value === null) return null;

  if (columnType === 'jsonb' || columnType === 'json') {
    return db.raw(`?::${columnType}`, [JSON.stringify(value)]);
  }
  if (columnType === 'ARRAY') {
    return Array.isArray(value) ? value : [value];
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'object') {
    // Unknown column type (or column missing from cache): store as JSON text.
    return JSON.stringify(value);
  }
  return value;
}

function serializeRow(db: Knex, columnTypes: Map<string, string>, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    if (isRpcIncrementMarker(value)) {
      out[key] = db.raw('?? + ?', [key, value.x]);
      continue;
    }
    out[key] = serializeValue(db, columnTypes.get(key), value);
  }
  return out;
}

function toPostgrestError(error: unknown): PostgrestError {
  const err = error as { message?: string; code?: string; detail?: string; hint?: string };
  return {
    message: err?.message ?? String(error),
    code: err?.code ?? 'WEBWOW',
    details: err?.detail ?? null,
    hint: err?.hint ?? null,
  };
}

function pgrst116(rows: number): PostgrestError {
  return {
    message: 'JSON object requested, multiple (or no) rows returned',
    code: 'PGRST116',
    details: `The result contains ${rows} rows`,
    hint: null,
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

type Operation =
  | { type: 'select' }
  | { type: 'insert'; values: Record<string, unknown>[] }
  | { type: 'upsert'; values: Record<string, unknown>[]; onConflict?: string; ignoreDuplicates?: boolean }
  | { type: 'update'; values: Record<string, unknown> }
  | { type: 'delete' };

export class PostgrestFilterBuilder<T = any> implements PromiseLike<PostgrestResponse<T>> {
  private readonly db: Knex;
  private readonly table: string;
  private readonly operation: Operation;
  private selectString: string | undefined;
  private countMode: 'exact' | 'planned' | 'estimated' | null = null;
  private headOnly = false;
  private readonly conditions: Condition[] = [];
  private readonly orders: OrderSpec[] = [];
  private limitValue: number | null = null;
  private offsetValue: number | null = null;
  private singleMode: 'single' | 'maybeSingle' | null = null;
  private shouldThrow = false;
  private returningRequested = false;

  constructor(db: Knex, table: string, operation: Operation, selectString?: string, options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }) {
    this.db = db;
    this.table = table;
    this.operation = operation;
    this.selectString = selectString;
    this.countMode = options?.count ?? null;
    this.headOnly = options?.head ?? false;
    if (operation.type !== 'select' && selectString !== undefined) {
      this.returningRequested = true;
    }
  }

  // ----- select after write (RETURNING) -----------------------------------

  select(columns = '*', options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): this {
    this.selectString = columns;
    this.returningRequested = true;
    if (options?.count) this.countMode = options.count;
    if (options?.head) this.headOnly = true;
    return this;
  }

  // ----- filters ----------------------------------------------------------

  private addFilter(column: string, op: FilterOperator, value: unknown, negate = false): this {
    this.conditions.push({ kind: 'filter', column: column.replace(/"/g, ''), op, value, negate });
    return this;
  }

  eq(column: string, value: unknown): this { return this.addFilter(column, 'eq', value); }
  neq(column: string, value: unknown): this { return this.addFilter(column, 'neq', value); }
  gt(column: string, value: unknown): this { return this.addFilter(column, 'gt', value); }
  gte(column: string, value: unknown): this { return this.addFilter(column, 'gte', value); }
  lt(column: string, value: unknown): this { return this.addFilter(column, 'lt', value); }
  lte(column: string, value: unknown): this { return this.addFilter(column, 'lte', value); }
  like(column: string, pattern: string): this { return this.addFilter(column, 'like', pattern); }
  ilike(column: string, pattern: string): this { return this.addFilter(column, 'ilike', pattern); }
  is(column: string, value: boolean | null): this { return this.addFilter(column, 'is', value); }
  in(column: string, values: readonly unknown[]): this { return this.addFilter(column, 'in', Array.from(values)); }
  contains(column: string, value: unknown): this { return this.addFilter(column, 'cs', value); }
  containedBy(column: string, value: unknown): this { return this.addFilter(column, 'cd', value); }
  overlaps(column: string, value: unknown): this { return this.addFilter(column, 'ov', value); }
  textSearch(column: string, query: string, options?: { type?: string }): this {
    const op = options?.type === 'plain' ? 'plfts' : options?.type === 'phrase' ? 'phfts' : options?.type === 'websearch' ? 'wfts' : 'fts';
    return this.addFilter(column, op, query);
  }

  not(column: string, operator: string, value: unknown): this {
    const op = OPERATOR_ALIASES[operator];
    if (!op) throw new Error(`Unsupported operator for not(): ${operator}`);
    let parsedValue = value;
    if (op === 'in' && typeof value === 'string') {
      parsedValue = splitTopLevel(value.replace(/^\(/, '').replace(/\)$/, '')).map(coerceFilterStringValue);
    }
    return this.addFilter(column, op, parsedValue, true);
  }

  filter(column: string, operator: string, value: unknown): this {
    let negate = false;
    let opName = operator;
    if (opName.startsWith('not.')) {
      negate = true;
      opName = opName.slice(4);
    }
    const op = OPERATOR_ALIASES[opName];
    if (!op) throw new Error(`Unsupported operator for filter(): ${operator}`);
    let parsedValue = value;
    if (op === 'in' && typeof value === 'string') {
      parsedValue = splitTopLevel(value.replace(/^\(/, '').replace(/\)$/, '')).map(coerceFilterStringValue);
    }
    return this.addFilter(column, op, parsedValue, negate);
  }

  match(query: Record<string, unknown>): this {
    for (const [column, value] of Object.entries(query)) {
      this.addFilter(column, 'eq', value);
    }
    return this;
  }

  or(filters: string, _options?: { referencedTable?: string; foreignTable?: string }): this {
    this.conditions.push({ kind: 'or', filters: parseFilterString(filters) });
    return this;
  }

  // ----- modifiers --------------------------------------------------------

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string }): this {
    this.orders.push({
      column: column.replace(/"/g, ''),
      ascending: options?.ascending ?? true,
      nullsFirst: options?.nullsFirst,
      referencedTable: options?.referencedTable ?? options?.foreignTable,
    });
    return this;
  }

  limit(count: number, _options?: { referencedTable?: string; foreignTable?: string }): this {
    this.limitValue = count;
    return this;
  }

  range(from: number, to: number, _options?: { referencedTable?: string; foreignTable?: string }): this {
    this.offsetValue = from;
    this.limitValue = to - from + 1;
    return this;
  }

  single(): this {
    this.singleMode = 'single';
    return this;
  }

  maybeSingle(): this {
    this.singleMode = 'maybeSingle';
    return this;
  }

  throwOnError(): this {
    this.shouldThrow = true;
    return this;
  }

  abortSignal(_signal: AbortSignal): this {
    return this;
  }

  returns<U>(): PostgrestFilterBuilder<U> {
    return this as unknown as PostgrestFilterBuilder<U>;
  }

  overrideTypes<U>(): PostgrestFilterBuilder<U> {
    return this as unknown as PostgrestFilterBuilder<U>;
  }

  csv(): never {
    throw new Error('csv() is not supported by the Webwow PostgREST shim');
  }

  explain(): never {
    throw new Error('explain() is not supported by the Webwow PostgREST shim');
  }

  // ----- execution --------------------------------------------------------

  then<TResult1 = PostgrestResponse<T>, TResult2 = never>(
    onfulfilled?: ((value: PostgrestResponse<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<PostgrestResponse<T>> {
    let response: PostgrestResponse<T>;
    try {
      response = this.operation.type === 'select' ? await this.executeSelect() : await this.executeWrite();
    } catch (error) {
      response = { data: null as unknown as T, error: toPostgrestError(error), count: null, status: 400, statusText: 'Bad Request' };
    }

    if (response.error && this.shouldThrow) {
      const err = new Error(response.error.message) as Error & PostgrestError;
      err.code = response.error.code;
      err.details = response.error.details;
      err.hint = response.error.hint;
      throw err;
    }

    return response;
  }

  /** Split conditions into base-table conditions and per-relation conditions. */
  private partitionConditions(relations: EmbeddedRelation[]): { base: Condition[]; related: Map<string, Filter[]> } {
    const related = new Map<string, Filter[]>();
    const base: Condition[] = [];
    const relationKeys = new Set(relations.map((r) => r.key));
    const relationTables = new Set(relations.map((r) => r.table));

    for (const condition of this.conditions) {
      if (condition.kind === 'filter') {
        const dot = condition.column.indexOf('.');
        if (dot > 0) {
          const prefix = condition.column.slice(0, dot);
          if (relationKeys.has(prefix) || relationTables.has(prefix)) {
            const relation = relations.find((r) => r.key === prefix) ?? relations.find((r) => r.table === prefix)!;
            const list = related.get(relation.key) ?? [];
            list.push({ ...condition, column: condition.column.slice(dot + 1) });
            related.set(relation.key, list);
            continue;
          }
        }
      }
      base.push(condition);
    }

    return { base, related };
  }

  private applyFilter(qb: Knex.QueryBuilder, filter: Filter, columnTypes: Map<string, string>, tableAlias?: string): void {
    const db = this.db;
    const ref = columnRef(db, filter.column, tableAlias);
    const type = columnTypes.get(filter.column.split('->')[0]);
    const { op, value } = filter;

    const apply = (builder: Knex.QueryBuilder) => {
      switch (op) {
        case 'eq':
          if (value === null) builder.whereNull(ref as string);
          else builder.where(ref as string, '=', value as Knex.Value);
          break;
        case 'neq':
          if (value === null) builder.whereNotNull(ref as string);
          else builder.where(ref as string, '<>', value as Knex.Value);
          break;
        case 'gt': builder.where(ref as string, '>', value as Knex.Value); break;
        case 'gte': builder.where(ref as string, '>=', value as Knex.Value); break;
        case 'lt': builder.where(ref as string, '<', value as Knex.Value); break;
        case 'lte': builder.where(ref as string, '<=', value as Knex.Value); break;
        case 'like': builder.where(ref as string, 'like', value as string); break;
        case 'ilike': builder.where(ref as string, 'ilike', value as string); break;
        case 'is':
          if (value === null) builder.whereNull(ref as string);
          else if (value === true) builder.whereRaw('?? IS TRUE', [ref as string]);
          else if (value === false) builder.whereRaw('?? IS FALSE', [ref as string]);
          else if (value === 'not_null') builder.whereNotNull(ref as string);
          else builder.whereNull(ref as string);
          break;
        case 'in': {
          const list = Array.isArray(value) ? value : [value];
          builder.whereIn(ref as string, list as Knex.Value[]);
          break;
        }
        case 'cs':
        case 'cd':
        case 'ov': {
          const sqlOp = op === 'cs' ? '@>' : op === 'cd' ? '<@' : '&&';
          if (type === 'jsonb' || type === 'json') {
            builder.whereRaw(`?? ${sqlOp} ?::jsonb`, [ref as string, JSON.stringify(value)]);
          } else if (type === 'ARRAY' || Array.isArray(value)) {
            builder.whereRaw(`?? ${sqlOp} ?`, [ref as string, Array.isArray(value) ? value : [value]] as Knex.RawBinding[]);
          } else {
            builder.whereRaw(`?? ${sqlOp} ?`, [ref as string, value as Knex.RawBinding]);
          }
          break;
        }
        case 'fts':
        case 'plfts':
        case 'phfts':
        case 'wfts': {
          const fn = op === 'fts' ? 'to_tsquery' : op === 'plfts' ? 'plainto_tsquery' : op === 'phfts' ? 'phraseto_tsquery' : 'websearch_to_tsquery';
          builder.whereRaw(`to_tsvector(??) @@ ${fn}(?)`, [ref as string, value as string]);
          break;
        }
        default:
          throw new Error(`Unsupported filter operator: ${op}`);
      }
    };

    if (filter.negate) {
      qb.whereNot((builder) => apply(builder));
    } else {
      apply(qb);
    }
  }

  private applyConditions(qb: Knex.QueryBuilder, conditions: Condition[], columnTypes: Map<string, string>, tableAlias?: string): void {
    for (const condition of conditions) {
      if (condition.kind === 'filter') {
        this.applyFilter(qb, condition, columnTypes, tableAlias);
      } else {
        qb.where((group) => {
          for (const filter of condition.filters) {
            group.orWhere((sub) => this.applyFilter(sub, filter, columnTypes, tableAlias));
          }
        });
      }
    }
  }

  private async executeSelect(): Promise<PostgrestResponse<T>> {
    const db = this.db;
    const parsed = parseSelect(this.selectString);
    const columnTypes = await getColumnTypes(db, this.table);
    const { base, related } = this.partitionConditions(parsed.relations);

    // Resolve relation links (foreign keys) and related column types up front.
    const links = new Map<string, RelationLink>();
    const relatedColumnTypes = new Map<string, Map<string, string>>();
    for (const relation of parsed.relations) {
      const link = await getRelation(db, this.table, relation.table);
      if (!link) {
        throw Object.assign(new Error(`Could not find a relationship between '${this.table}' and '${relation.table}' in the schema`), { code: 'PGRST200' });
      }
      links.set(relation.key, link);
      relatedColumnTypes.set(relation.key, await getColumnTypes(db, relation.table));
    }

    const buildBaseQuery = (): Knex.QueryBuilder => {
      const qb = db(this.table);
      this.applyConditions(qb, base, columnTypes, this.table);

      // `!inner` embeds restrict the base rows to those with at least one related row.
      for (const relation of parsed.relations) {
        if (relation.modifier !== 'inner') continue;
        const link = links.get(relation.key)!;
        const relatedFilters = related.get(relation.key) ?? [];
        const relatedTypes = relatedColumnTypes.get(relation.key) ?? new Map<string, string>();
        qb.whereExists((sub) => {
          sub.select(db.raw('1')).from(relation.table);
          link.baseColumns.forEach((baseColumn, index) => {
            sub.whereRaw('?? = ??', [`${relation.table}.${link.relatedColumns[index]}`, `${this.table}.${baseColumn}`]);
          });
          relatedFilters.forEach((filter) => this.applyFilter(sub, filter, relatedTypes, relation.table));
        });
      }
      return qb;
    };

    // Count query (independent of limit/offset/order).
    let count: number | null = null;
    if (this.countMode) {
      const countRow = await buildBaseQuery().count<{ count: number | string }[]>('* as count').first();
      count = countRow ? Number(countRow.count) : 0;
    }

    if (this.headOnly) {
      return { data: null as unknown as T, error: null, count, status: 200, statusText: 'OK' };
    }

    const qb = buildBaseQuery();
    for (const order of this.orders) {
      if (order.referencedTable) continue; // ordering embedded rows is not supported
      const ref = columnRef(db, order.column, this.table);
      const direction = order.ascending ? 'asc' : 'desc';
      if (order.nullsFirst === undefined) {
        qb.orderBy(ref as string, direction);
      } else {
        qb.orderBy(ref as string, direction, order.nullsFirst ? 'first' : 'last');
      }
    }
    if (this.limitValue !== null) qb.limit(this.limitValue);
    if (this.offsetValue !== null) qb.offset(this.offsetValue);

    // Column selection: keep the join keys around so embedded rows can be attached.
    const wantsAll = parsed.columns.includes('*');
    const requestedColumns = parsed.columns.filter((c) => c !== '*');
    const hiddenColumns = new Set<string>();
    if (wantsAll) {
      qb.select(`${this.table}.*`);
    } else {
      const selectList: Array<string | Knex.Raw> = [];
      const explicit = new Set<string>();
      for (const item of requestedColumns) {
        const aliased = item.match(/^([A-Za-z0-9_]+):(.+)$/);
        if (aliased) {
          selectList.push(db.raw('?? as ??', [`${this.table}.${aliased[2]}`, aliased[1]]));
          explicit.add(aliased[1]);
        } else if (item.includes('->')) {
          selectList.push(db.raw('? as ??', [columnRef(db, item, this.table), item]));
          explicit.add(item);
        } else {
          selectList.push(`${this.table}.${item}`);
          explicit.add(item);
        }
      }
      for (const link of links.values()) {
        for (const column of link.baseColumns) {
          if (!explicit.has(column)) {
            selectList.push(`${this.table}.${column}`);
            hiddenColumns.add(column);
          }
        }
      }
      qb.select(selectList);
    }

    const rows = (await qb) as Record<string, unknown>[];

    // Attach embedded relations.
    for (const relation of parsed.relations) {
      const link = links.get(relation.key)!;
      const relatedFilters = related.get(relation.key) ?? [];
      const relatedTypes = relatedColumnTypes.get(relation.key) ?? new Map<string, string>();
      const emptyValue = link.type === 'many' ? [] : null;

      if (rows.length === 0) continue;

      const baseKeys = rows.map((row) => link.baseColumns.map((c) => row[c]));
      const relatedQb = db(relation.table);
      if (link.relatedColumns.length === 1) {
        relatedQb.whereIn(`${relation.table}.${link.relatedColumns[0]}`, baseKeys.map((k) => k[0]) as Knex.Value[]);
      } else {
        relatedQb.whereIn(link.relatedColumns.map((c) => `${relation.table}.${c}`), baseKeys as Knex.Value[][]);
      }
      relatedFilters.forEach((filter) => this.applyFilter(relatedQb, filter, relatedTypes, relation.table));

      const relatedWantsAll = relation.columns.includes('*');
      const relatedHidden = new Set<string>();
      if (relatedWantsAll) {
        relatedQb.select(`${relation.table}.*`);
      } else {
        const list = relation.columns.map((c) => `${relation.table}.${c}`);
        for (const column of link.relatedColumns) {
          if (!relation.columns.includes(column)) {
            list.push(`${relation.table}.${column}`);
            relatedHidden.add(column);
          }
        }
        relatedQb.select(list);
      }

      const relatedRows = (await relatedQb) as Record<string, unknown>[];
      const grouped = new Map<string, Record<string, unknown>[]>();
      for (const relatedRow of relatedRows) {
        const key = rowKey(relatedRow, link.relatedColumns);
        const list = grouped.get(key) ?? [];
        const cleaned = { ...relatedRow };
        for (const hidden of relatedHidden) delete cleaned[hidden];
        list.push(cleaned);
        grouped.set(key, list);
      }

      for (const row of rows) {
        const matches = grouped.get(rowKey(row, link.baseColumns)) ?? [];
        row[relation.key] = link.type === 'many' ? matches : (matches[0] ?? emptyValue);
      }
    }

    for (const row of rows) {
      for (const hidden of hiddenColumns) delete row[hidden];
    }

    return this.finalize(rows, count, 200, 'OK');
  }

  private async executeWrite(): Promise<PostgrestResponse<T>> {
    const db = this.db;
    const columnTypes = await getColumnTypes(db, this.table);
    const op = this.operation;
    const parsed = parseSelect(this.selectString ?? '*');
    const returning = this.returningRequested
      ? (parsed.columns.includes('*') ? ['*'] : parsed.columns)
      : null;

    let rows: Record<string, unknown>[] = [];
    let status = 200;
    let statusText = 'OK';

    if (op.type === 'insert' || op.type === 'upsert') {
      const values = op.values.map((row) => serializeRow(db, columnTypes, row));
      if (values.length === 0) {
        return { data: (returning ? [] : null) as unknown as T, error: null, count: null, status: 201, statusText: 'Created' };
      }
      let qb = db(this.table).insert(values);
      if (op.type === 'upsert') {
        const conflictColumns = op.onConflict
          ? op.onConflict.split(',').map((c) => c.trim()).filter(Boolean)
          : await getPrimaryKey(db, this.table);
        const conflict = qb.onConflict(conflictColumns);
        qb = op.ignoreDuplicates ? conflict.ignore() : conflict.merge();
      }
      if (returning) qb = qb.returning(returning);
      const result = (await qb) as unknown;
      rows = returning ? (result as Record<string, unknown>[]) : [];
      status = 201;
      statusText = 'Created';
    } else if (op.type === 'update') {
      const values = serializeRow(db, columnTypes, op.values);
      let qb = db(this.table);
      this.applyConditions(qb, this.conditions, columnTypes);
      if (Object.keys(values).length === 0) {
        // PostgREST returns the matching rows unchanged for an empty patch.
        rows = returning ? ((await qb.select(returning)) as Record<string, unknown>[]) : [];
      } else {
        qb = qb.update(values);
        if (returning) qb = qb.returning(returning);
        const result = (await qb) as unknown;
        rows = returning ? (result as Record<string, unknown>[]) : [];
      }
    } else if (op.type === 'delete') {
      let qb = db(this.table);
      this.applyConditions(qb, this.conditions, columnTypes);
      qb = qb.delete();
      if (returning) qb = qb.returning(returning);
      const result = (await qb) as unknown;
      rows = returning ? (result as Record<string, unknown>[]) : [];
    }

    if (!returning) {
      return { data: null as unknown as T, error: null, count: null, status: status === 201 ? 201 : 204, statusText: status === 201 ? 'Created' : 'No Content' };
    }

    return this.finalize(rows, null, status, statusText);
  }

  private finalize(rows: Record<string, unknown>[], count: number | null, status: number, statusText: string): PostgrestResponse<T> {
    if (this.singleMode === 'single') {
      if (rows.length !== 1) {
        return { data: null as unknown as T, error: pgrst116(rows.length), count, status: 406, statusText: 'Not Acceptable' };
      }
      return { data: rows[0] as unknown as T, error: null, count, status, statusText };
    }
    if (this.singleMode === 'maybeSingle') {
      if (rows.length > 1) {
        return { data: null as unknown as T, error: pgrst116(rows.length), count, status: 406, statusText: 'Not Acceptable' };
      }
      return { data: (rows[0] ?? null) as unknown as T, error: null, count, status, statusText };
    }
    return { data: rows as unknown as T, error: null, count, status, statusText };
  }
}

export class PostgrestQueryBuilder {
  constructor(private readonly db: Knex, private readonly table: string) {}

  select<T = any>(columns = '*', options?: { count?: 'exact' | 'planned' | 'estimated'; head?: boolean }): PostgrestFilterBuilder<T> {
    return new PostgrestFilterBuilder<T>(this.db, this.table, { type: 'select' }, columns, options);
  }

  insert<T = any>(values: Record<string, unknown> | Record<string, unknown>[], _options?: { count?: string; defaultToNull?: boolean }): PostgrestFilterBuilder<T> {
    return new PostgrestFilterBuilder<T>(this.db, this.table, { type: 'insert', values: Array.isArray(values) ? values : [values] });
  }

  upsert<T = any>(values: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string; ignoreDuplicates?: boolean; count?: string; defaultToNull?: boolean }): PostgrestFilterBuilder<T> {
    return new PostgrestFilterBuilder<T>(this.db, this.table, {
      type: 'upsert',
      values: Array.isArray(values) ? values : [values],
      onConflict: options?.onConflict,
      ignoreDuplicates: options?.ignoreDuplicates,
    });
  }

  update<T = any>(values: Record<string, unknown>, _options?: { count?: string }): PostgrestFilterBuilder<T> {
    return new PostgrestFilterBuilder<T>(this.db, this.table, { type: 'update', values });
  }

  delete<T = any>(_options?: { count?: string }): PostgrestFilterBuilder<T> {
    return new PostgrestFilterBuilder<T>(this.db, this.table, { type: 'delete' });
  }
}

/**
 * Execute a stored-procedure style call. Upstream uses only a handful of RPCs;
 * they are implemented here in SQL instead of database functions.
 */
export async function executeRpc(db: Knex, name: string, params: Record<string, unknown> = {}): Promise<PostgrestResponse<any>> {
  try {
    switch (name) {
      case 'exec_sql': {
        await db.raw(String(params.sql ?? ''));
        return { data: null, error: null, count: null, status: 204, statusText: 'No Content' };
      }
      case 'increment_webhook_failure_count': {
        await db('webhooks')
          .where('id', params.webhook_id as string)
          .update({ failure_count: db.raw('failure_count + 1'), updated_at: new Date().toISOString() });
        return { data: null, error: null, count: null, status: 204, statusText: 'No Content' };
      }
      case 'get_top_items_per_collection': {
        const ids = (params.p_collection_ids as string[]) ?? [];
        const isPublished = Boolean(params.p_is_published);
        const limit = Number(params.p_limit ?? 10);
        if (ids.length === 0) return { data: [], error: null, count: null, status: 200, statusText: 'OK' };
        const result = await db.raw(
          `SELECT * FROM (
             SELECT ci.*, row_number() OVER (PARTITION BY ci.collection_id ORDER BY ci.manual_order ASC, ci.created_at DESC) AS __rn
               FROM collection_items ci
              WHERE ci.collection_id = ANY(?::uuid[]) AND ci.is_published = ? AND ci.deleted_at IS NULL
                ${isPublished ? 'AND ci.is_publishable = TRUE' : ''}
           ) t WHERE __rn <= ? ORDER BY collection_id, __rn`,
          [ids, isPublished, limit],
        );
        const rows = (result.rows as Record<string, unknown>[]).map((row) => {
          const { __rn, ...rest } = row;
          void __rn;
          return rest;
        });
        return { data: rows, error: null, count: null, status: 200, statusText: 'OK' };
      }
      default:
        return {
          data: null,
          error: { message: `RPC '${name}' is not implemented in the Webwow compatibility layer`, code: 'PGRST202', details: null, hint: null },
          count: null,
          status: 404,
          statusText: 'Not Found',
        };
    }
  } catch (error) {
    return { data: null, error: toPostgrestError(error), count: null, status: 400, statusText: 'Bad Request' };
  }
}

/**
 * `client.rpc(name, params)` returns a thenable. When `name === 'increment'` the
 * returned object also acts as a value marker for `.update({ col: client.rpc('increment', { x: 1 }) })`.
 */
export function createRpcCall(db: Knex, name: string, params: Record<string, unknown> = {}): PromiseLike<PostgrestResponse<any>> & Partial<RpcIncrementMarker> {
  const thenable = {
    then<TResult1 = PostgrestResponse<any>, TResult2 = never>(
      onfulfilled?: ((value: PostgrestResponse<any>) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return executeRpc(db, name, params).then(onfulfilled, onrejected);
    },
  } as PromiseLike<PostgrestResponse<any>> & Partial<RpcIncrementMarker>;

  if (name === 'increment') {
    thenable.__webwowRpc = 'increment';
    thenable.x = Number(params.x ?? 1);
  }

  return thenable;
}
