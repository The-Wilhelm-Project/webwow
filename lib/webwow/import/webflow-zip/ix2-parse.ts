/**
 * Webflow IX2 (Interactions 2.0) data extraction.
 *
 * A Webflow site export ships its interactions inside the site JS file as
 *
 *   Webflow.require("ix2").init({ events: {...}, actionLists: {...}, site: {...} });
 *
 * The argument is a minified JavaScript object literal, not JSON: keys are
 * mostly unquoted, booleans are written as `!0` / `!1`, numbers may be hex
 * (`0x17ea5c95c10`) or exponent form (`1e3`), and `void 0` may appear. This
 * module contains a small tolerant tokenizer/parser for that subset so the data
 * can be read WITHOUT evaluating untrusted JavaScript (no eval / vm).
 */

// ─── Types (subset of the IX2 schema that the importer maps) ──────────────────

export interface Ix2Target {
  selector?: string;
  originalId?: string;
  appliesTo?: string; // 'CLASS' | 'ELEMENT' | 'TRIGGER_ELEMENT' | 'PAGE' | ...
  id?: string;
  useEventTarget?: boolean | string; // true | 'CHILDREN' | 'SIBLINGS' | 'PARENT'
  selectorGuids?: string[];
  boundaryMode?: boolean;
}

export interface Ix2Event {
  id: string;
  name?: string;
  animationType?: string; // 'custom' | 'preset'
  eventTypeId: string; // 'MOUSE_OVER' | 'MOUSE_OUT' | 'MOUSE_CLICK' | 'SCROLL_INTO_VIEW' | ...
  action?: {
    id?: string;
    actionTypeId?: string; // 'GENERAL_START_ACTION' | 'GENERAL_CONTINUOUS_ACTION' | ...
    config?: {
      delay?: number;
      easing?: string;
      duration?: number;
      actionListId?: string;
      affectedElements?: Record<string, unknown>;
      playInReverse?: boolean;
      autoStopEventId?: string;
      [key: string]: unknown;
    };
  };
  mediaQueries?: string[];
  target?: Ix2Target;
  targets?: Ix2Target[];
  config?: {
    loop?: boolean;
    playInReverse?: boolean;
    scrollOffsetValue?: number | null;
    scrollOffsetUnit?: string | null;
    delay?: number | null;
    direction?: string | null;
    effectIn?: boolean | null;
    [key: string]: unknown;
  };
  createdOn?: number;
  [key: string]: unknown;
}

export interface Ix2ActionItemConfig {
  delay?: number;
  easing?: string;
  duration?: number;
  target?: Ix2Target;
  // transform / style values
  xValue?: number | null;
  yValue?: number | null;
  zValue?: number | null;
  xUnit?: string;
  yUnit?: string;
  zUnit?: string;
  value?: number | string | null;
  unit?: string;
  widthValue?: number | null;
  heightValue?: number | null;
  widthUnit?: string;
  heightUnit?: string;
  locked?: boolean;
  rValue?: number;
  gValue?: number;
  bValue?: number;
  aValue?: number;
  globalSwatchId?: string;
  [key: string]: unknown;
}

export interface Ix2ActionItem {
  id?: string;
  actionTypeId: string; // 'TRANSFORM_MOVE' | 'STYLE_OPACITY' | ...
  config: Ix2ActionItemConfig;
}

export interface Ix2ActionList {
  id: string;
  title?: string;
  actionItemGroups?: Array<{ actionItems: Ix2ActionItem[] }>;
  continuousParameterGroups?: Array<{
    id?: string;
    type?: string;
    parameterLabel?: string;
    continuousActionGroups?: Array<{ keyframe: number; actionItems: Ix2ActionItem[] }>;
  }>;
  useFirstGroupAsInitialState?: boolean;
  createdOn?: number;
  [key: string]: unknown;
}

export interface Ix2Data {
  events: Record<string, Ix2Event>;
  actionLists: Record<string, Ix2ActionList>;
  site?: {
    mediaQueries?: Array<{ key: string; min: number; max: number }>;
    [key: string]: unknown;
  };
}

// ─── Extraction ───────────────────────────────────────────────────────────────

const INIT_PATTERNS = [
  'Webflow.require("ix2").init(',
  "Webflow.require('ix2').init(",
];

/**
 * Locate the IX2 init argument inside a Webflow site JS file and return the raw
 * object-literal source (without the surrounding `init(` … `)`), or null.
 */
export function extractIx2Literal(js: string): string | null {
  let start = -1;
  for (const pattern of INIT_PATTERNS) {
    const idx = js.indexOf(pattern);
    if (idx !== -1) {
      start = idx + pattern.length;
      break;
    }
  }
  if (start === -1) return null;

  // Scan to the matching closing parenthesis, skipping string contents.
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < js.length; i++) {
    const ch = js[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth++; continue; }
    if (ch === ')' || ch === '}' || ch === ']') {
      if (depth === 0) return js.slice(start, i);
      depth--;
    }
  }
  return null;
}

// ─── Tolerant object-literal parser ───────────────────────────────────────────

type Token =
  | { type: 'punct'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'ident'; value: string };

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = src.length;

  while (i < len) {
    const ch = src[i];

    // whitespace
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') { i++; continue; }

    // comments (unlikely in minified output, but cheap to support)
    if (ch === '/' && src[i + 1] === '/') {
      while (i < len && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }

    // punctuation
    if ('{}[]:,'.includes(ch)) { tokens.push({ type: 'punct', value: ch }); i++; continue; }

    // `!0` / `!1` minified booleans
    if (ch === '!' && (src[i + 1] === '0' || src[i + 1] === '1')) {
      tokens.push({ type: 'ident', value: src[i + 1] === '0' ? 'true' : 'false' });
      i += 2;
      continue;
    }

    // strings
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let out = '';
      i++;
      while (i < len && src[i] !== quote) {
        const c = src[i];
        if (c === '\\') {
          const n = src[i + 1];
          if (n === 'n') out += '\n';
          else if (n === 't') out += '\t';
          else if (n === 'r') out += '\r';
          else if (n === 'b') out += '\b';
          else if (n === 'f') out += '\f';
          else if (n === 'v') out += '\v';
          else if (n === '0') out += String.fromCharCode(0);
          else if (n === 'u') {
            const hex = src.slice(i + 2, i + 6);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
          } else if (n === 'x') {
            const hex = src.slice(i + 2, i + 4);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 2; }
          } else if (n !== undefined) out += n;
          i += 2;
          continue;
        }
        out += c;
        i++;
      }
      i++; // closing quote
      tokens.push({ type: 'string', value: out });
      continue;
    }

    // numbers (optional sign handled here so `-5` and `-.5` work)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? '')) || ((ch === '-' || ch === '+') && /[0-9.]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-' || src[j] === '+') j++;
      if (src[j] === '0' && (src[j + 1] === 'x' || src[j + 1] === 'X')) {
        j += 2;
        while (j < len && /[0-9a-fA-F]/.test(src[j])) j++;
        const text = src.slice(i, j);
        tokens.push({ type: 'number', value: Number(text.replace('+', '')) });
        i = j;
        continue;
      }
      while (j < len && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.') { j++; while (j < len && /[0-9]/.test(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (/[0-9]/.test(src[k] ?? '')) {
          j = k;
          while (j < len && /[0-9]/.test(src[j])) j++;
        }
      }
      tokens.push({ type: 'number', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }

    // identifiers / keywords (unquoted keys, true/false/null/undefined, void)
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < len && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      if (word === 'void') {
        // `void 0` → undefined
        let k = j;
        while (k < len && src[k] === ' ') k++;
        if (src[k] === '0') { tokens.push({ type: 'ident', value: 'undefined' }); i = k + 1; continue; }
      }
      tokens.push({ type: 'ident', value: word });
      i = j;
      continue;
    }

    throw new Error(`IX2 parse error: unexpected character ${JSON.stringify(ch)} at ${i}`);
  }

  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const tok = this.tokens[this.pos++];
    if (!tok) throw new Error('IX2 parse error: unexpected end of input');
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.type !== 'punct' || tok.value !== value) {
      throw new Error(`IX2 parse error: expected ${JSON.stringify(value)} but got ${JSON.stringify(tok.value)}`);
    }
  }

  private isPunct(value: string): boolean {
    const tok = this.peek();
    return !!tok && tok.type === 'punct' && tok.value === value;
  }

  parseValue(): unknown {
    const tok = this.next();
    switch (tok.type) {
      case 'string':
        return tok.value;
      case 'number':
        return tok.value;
      case 'ident':
        if (tok.value === 'true') return true;
        if (tok.value === 'false') return false;
        if (tok.value === 'null') return null;
        if (tok.value === 'undefined') return undefined;
        if (tok.value === 'NaN') return Number.NaN;
        if (tok.value === 'Infinity') return Number.POSITIVE_INFINITY;
        throw new Error(`IX2 parse error: unexpected identifier ${tok.value}`);
      case 'punct':
        if (tok.value === '{') return this.parseObject();
        if (tok.value === '[') return this.parseArray();
        throw new Error(`IX2 parse error: unexpected token ${tok.value}`);
    }
  }

  private parseObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    while (!this.isPunct('}')) {
      const keyTok = this.next();
      let key: string;
      if (keyTok.type === 'string' || keyTok.type === 'ident') key = keyTok.value;
      else if (keyTok.type === 'number') key = String(keyTok.value);
      else throw new Error(`IX2 parse error: invalid object key ${JSON.stringify(keyTok.value)}`);
      this.expectPunct(':');
      out[key] = this.parseValue();
      if (this.isPunct(',')) { this.next(); continue; }
      if (!this.isPunct('}')) throw new Error('IX2 parse error: expected , or } in object');
    }
    this.next(); // }
    return out;
  }

  private parseArray(): unknown[] {
    const out: unknown[] = [];
    while (!this.isPunct(']')) {
      out.push(this.parseValue());
      if (this.isPunct(',')) { this.next(); continue; }
      if (!this.isPunct(']')) throw new Error('IX2 parse error: expected , or ] in array');
    }
    this.next(); // ]
    return out;
  }

  done(): boolean {
    return this.pos >= this.tokens.length;
  }
}

/**
 * Parse a JavaScript object/array literal in the minified Webflow subset
 * (unquoted keys, `!0`/`!1`, hex/exponent numbers, `void 0`, trailing commas).
 * Never evaluates code.
 */
export function parseJsObjectLiteral(src: string): unknown {
  const parser = new Parser(tokenize(src));
  const value = parser.parseValue();
  if (!parser.done()) throw new Error('IX2 parse error: trailing tokens after literal');
  return value;
}

/**
 * Extract and parse the IX2 data from a Webflow site JS file.
 * Returns null when the file contains no IX2 init call.
 */
export function parseIx2FromJs(js: string): Ix2Data | null {
  const literal = extractIx2Literal(js);
  if (literal === null) return null;
  const data = parseJsObjectLiteral(literal) as Partial<Ix2Data> | null;
  if (!data || typeof data !== 'object') return null;
  return {
    events: (data.events ?? {}) as Record<string, Ix2Event>,
    actionLists: (data.actionLists ?? {}) as Record<string, Ix2ActionList>,
    site: data.site,
  };
}
