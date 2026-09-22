import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cssToClasses } from '@/lib/import/css';
import { buildDesign } from '@/lib/import/design';
import { getAffectedProperties } from '@/lib/tailwind-class-mapper';
import { mergeClassStack, splitVariant } from '@/lib/layer-style-resolve';
import { parseSelector, tokenizeCss } from './css-tokenizer';
import { Warnings } from './warnings';
import { dropShadowedClasses } from './convert-bridge';
import {
  BOUND_BG_PLACEHOLDER,
  BREAKPOINT_PREFIX,
  FONT_WEIGHT_KEYWORDS,
  STATE_PREFIX,
  bodyClassesFor,
  buildStyleModel,
  contextualStateOf,
  expandBorderSide,
  fontStackOf,
  isSafeFontFamilyName,
  keepBackgroundLayersApart,
  keepColourBesideGradient,
  liftComboOverBreakpoints,
  mediaKey,
  mergePrefixedClasses,
  namespaceSelector,
  normaliseDeclarations,
  repairFontWeightClass,
  rewriteCssUrls,
  richTextDescendantScope,
  safeFontFallback,
  wfClass,
  type WfStyleModel,
} from './css';

const NO_ASSETS = () => null;

/** Every class the style model hands to the converter (styles, combos, id one-offs, tag underlays). */
function emittedClasses(model: WfStyleModel): Set<string> {
  const out = new Set<string>();
  for (const v of model.classes.values()) v.ref.classes.forEach((c) => out.add(c));
  for (const v of model.combos.values()) v.classes.forEach((c) => out.add(c));
  for (const v of model.ids.values()) v.forEach((c) => out.add(c));
  for (const v of model.tags.values()) v.classes.forEach((c) => out.add(c));
  return out;
}

/** Bare Tailwind utilities `cssToClasses` emits that upstream's design mapper does not index. */
const BARE_UTILITIES = new Set([
  'grow', 'grow-0', 'shrink', 'shrink-0', 'basis-auto', 'italic', 'not-italic',
  'whitespace-nowrap', 'whitespace-pre', 'whitespace-pre-wrap', 'whitespace-pre-line', 'whitespace-normal',
  'break-words', 'break-all', 'pointer-events-none', 'pointer-events-auto',
]);

/**
 * Class hygiene (SPEC D1): an emitted class is either a Tailwind utility the
 * design panel understands, a bare utility from the list above, an arbitrary
 * value / arbitrary property, optionally behind a breakpoint / state prefix.
 * Raw Webflow class names (`section`, `w-nav`, `wf-…`) never qualify.
 */
function isExplainedClass(cls: string): boolean {
  const { prefix, base } = splitVariant(cls);
  if (prefix && !/^(max-lg:|max-md:)?(hover:|focus:|active:)?$/.test(prefix)) return false;
  if (!base || /\s/.test(base) || base.startsWith('wf-')) return false;
  if (getAffectedProperties(base).length > 0) return true;
  if (BARE_UTILITIES.has(base)) return true;
  if (/^\[[a-z][a-z0-9-]*:[^\]]+\]$/.test(base)) return true; // arbitrary property `[inset:0%_0%_auto]`
  if (/^-?[a-z][a-z0-9-]*-\[[^\]]+\]$/.test(base)) return true; // arbitrary value `-inset-[100%]`, `basis-[10px]`
  return false;
}

test('namespaceSelector rewrites every class token and leaves ids, tags, pseudos and strings alone', () => {
  assert.equal(namespaceSelector('.a.b:hover .c'), '.wf-a.wf-b:hover .wf-c');
  assert.equal(namespaceSelector('#w-node-x.cell > p.Big_One::after'), '#w-node-x.wf-cell > p.wf-big_one::after');
  assert.equal(namespaceSelector('.a:not(.b)[data-x=".c"]'), '.wf-a:not(.wf-b)[data-x=".c"]');
  assert.equal(namespaceSelector('.a[title=".b"] .c'), '.wf-a[title=".b"] .wf-c');
  assert.equal(namespaceSelector('html, body'), 'html, body');
  assert.equal(namespaceSelector('.\\32 x'), '.wf-\\32 x');
  assert.equal(wfClass('Fixed Menu Item'), 'wf-fixed-menu-item');
  assert.equal(wfClass('w--current'), 'wf-w--current');
});

test('mergePrefixedClasses resolves conflicts per prefix incl. shorthand / longhand pairs', () => {
  assert.deepEqual(mergePrefixedClasses(['p-[10px]', 'max-lg:p-[4px]', 'p-[12px]', 'hover:bg-[#eee]']), ['max-lg:p-[4px]', 'p-[12px]', 'hover:bg-[#eee]']);
  assert.deepEqual(mergePrefixedClasses(['pt-[20px]', 'p-[60px]']), ['p-[60px]']);
  assert.deepEqual(mergePrefixedClasses(['p-[10px]', 'pt-[20px]']), ['p-[10px]', 'pt-[20px]']);
  assert.deepEqual(mergePrefixedClasses(['max-lg:p-[50px]', 'max-lg:p-[40px]', 'max-md:p-[30px]']), ['max-lg:p-[40px]', 'max-md:p-[30px]']);
  assert.deepEqual(mergePrefixedClasses(['text-[24px]', 'text-[#fff]', 'text-[18px]']), ['text-[#fff]', 'text-[18px]']);
  assert.deepEqual(mergePrefixedClasses(['flex', 'hidden', 'flex']), ['flex'], 'duplicates collapse');
  // Arbitrary properties are evicted by CSS longhands (upstream's rules do not know them), per prefix.
  assert.deepEqual(mergePrefixedClasses(['[inset:0]', '[inset:1px]', '']), ['[inset:1px]']);
  assert.deepEqual(mergePrefixedClasses(['[top:0]', '[inset:1px]', 'max-md:[inset:2px]']), ['[inset:1px]', 'max-md:[inset:2px]']);
  assert.deepEqual(mergePrefixedClasses(['[inset:1px]', '[top:0]']), ['[inset:1px]', '[top:0]'], 'a later longhand refines');
  assert.deepEqual(mergePrefixedClasses(['pt-[5px]', '[padding:0]', '[background-color:red]', 'bg-[#fff]']), ['[padding:0]', 'bg-[#fff]']);
  assert.deepEqual(mergePrefixedClasses(['[border-top-style:none]', 'border-solid']), ['border-solid']);
});

test('normaliseDeclarations prepares a block for cssToClasses', () => {
  const warn = new Warnings();
  const decls = tokenizeCss(`.x{
    color: var(--c);
    font-family: "Neue Haas", Arial, sans-serif;
    flex-flow: column wrap;
    -webkit-backdrop-filter: blur(2px);
    --token: 1;
    background-image: url('../images/x.jpg');
    background: url('https://${BOUND_BG_PLACEHOLDER}');
    width: expression(alert(1));
    padding: 1px !important;
    padding: 2px;
  }`).rules[0].declarations;
  const assetUrl = (rel: string) => (rel === '../images/x.jpg' ? '/storage/v1/object/public/assets/website/x.webp' : null);
  const result = normaliseDeclarations(decls, { '--c': '#123456' }, assetUrl, warn);
  assert.equal(result.css, 'color: #123456; font-family: Neue_Haas; flex-direction: column; flex-wrap: wrap; background-image: url(/storage/v1/object/public/assets/website/x.webp); padding: 2px');
  assert.equal(result.boundBackground, true);
  assert.deepEqual(result.dropped.map((d) => d.prop), ['-webkit-backdrop-filter', '--token', 'width']);
  assert.equal(warn.count('css_dropped'), 3);
  assert.deepEqual(cssToClasses(result.css), ['text-[#123456]', 'font-[Neue_Haas]', 'flex-col', 'flex-wrap', 'bg-[url(/storage/v1/object/public/assets/website/x.webp)]', 'p-[2px]']);
});

test('rewriteCssUrls resolves export-relative urls, unquotes absolute ones and reports missing files', () => {
  const warn = new Warnings();
  const assetUrl = (rel: string) => (rel.endsWith('a.png') ? '/storage/a.webp' : null);
  assert.equal(rewriteCssUrls('url("../images/a.png"), url(\'../images/missing.png\')', assetUrl, warn), 'url(/storage/a.webp), url(../images/missing.png)');
  assert.equal(warn.count('asset_missing'), 1);
  assert.equal(rewriteCssUrls('url("https://x/y z.png")', assetUrl), 'url("https://x/y z.png")');
  assert.equal(rewriteCssUrls('url(\'https://x/y.png\') no-repeat', assetUrl), 'url(https://x/y.png) no-repeat');
  assert.equal(rewriteCssUrls('url(data:image/png;base64,AA==)', assetUrl), 'url(data:image/png;base64,AA==)');
  assert.equal(rewriteCssUrls('url(#frag)', assetUrl), 'url(#frag)');
  assert.equal(rewriteCssUrls('url(/storage/x.png)', assetUrl), 'url(/storage/x.png)');
  assert.equal(mediaKey('screen and (max-width: 479px)'), '(max-width:479px)');
  assert.equal(mediaKey('only screen and (min-width: 768px) and (max-width: 991px)'), '(min-width:768px) and (max-width:991px)');
  assert.equal(mediaKey(null), '');
  assert.deepEqual(BREAKPOINT_PREFIX, { main: '', medium: 'max-lg:', small: 'max-md:' });
  assert.deepEqual(STATE_PREFIX, { ':hover': 'hover:', ':focus': 'focus:', ':active': 'active:' });
});

test('buildStyleModel classifies rules into classes, combos, ids, tag underlays and residual CSS', () => {
  const warn = new Warnings();
  const css = `
:root{--c:#123456}
.card{display:flex;padding:10px;color:var(--c);font-family:"Neue Haas", Arial, sans-serif;flex-flow:column wrap;-webkit-backdrop-filter:blur(2px);background-image:url('../images/x.jpg')}
.card:hover{background-color:#eee}
.card.dark{background-color:#000;padding:0}
.card.dark:focus{outline:none}
.card:focus-visible{outline:1px solid red}
.card .inner{margin:0}
#w-node-abc{grid-area:span 1 / span 2}
#w-node-abc.cell{padding:1px}
@media screen and (max-width:991px){.card{padding:4px}#w-node-abc{grid-column:span 2}}
@media screen and (max-width:767px){.card{padding:3px}.card:hover{color:#fff}}
@media screen and (max-width:479px){.card{padding:2px}.card.dark{padding:1px}#w-node-abc{grid-column:span 1}}
@media (min-width:1280px){.card{padding:20px}}
.bg{background-image:url('https://${BOUND_BG_PLACEHOLDER}')}
.evil{width:expression(alert(1));content:"</style>"}
p{margin-bottom:10px}
a{color:#000}
a:visited{color:red}
h1{font-size:40px}
html{font-size:calc(1rem + 1vw)}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@font-face{font-family:Foo;src:url('../fonts/foo.woff2') format("woff2");font-weight:700}
@font-face{font-family:Foo;src:url('../fonts/foo-dup.woff2') format("woff2");font-weight:700}
`;
  const assetUrl = (rel: string) => (rel === '../images/x.jpg' ? '/storage/x.webp' : null);
  const model = buildStyleModel({ siteCss: [css], assetUrl, warn });

  const card = model.classes.get('card')!;
  assert.deepEqual({ key: card.ref.key, name: card.ref.name, combo: card.ref.combo, bound: card.boundBackground }, { key: 'wf:card', name: 'card', combo: undefined, bound: false });
  assert.deepEqual(card.ref.classes, [
    'flex', 'p-[10px]', 'text-[#123456]', 'font-[Neue_Haas]', 'flex-col', 'flex-wrap', 'bg-[url(/storage/x.webp)]',
    'max-lg:p-[4px]', 'max-md:p-[3px]', 'hover:bg-[#eee]', 'max-md:hover:text-[#fff]',
  ]);
  // `.card.dark { padding: 0 }` outranks `.card`'s 991 / 767 px paddings in Webflow (two classes beat
  // one at every breakpoint). As chips, `max-lg:p-[4px]` of the base would win below 992 px, so the
  // combo re-states its value exactly on the breakpoints where the base sets padding (combo precedence).
  assert.deepEqual(model.combos.get('card.dark'), { key: 'wf:card.dark', name: 'card dark', classes: ['max-lg:p-[0]', 'max-md:p-[0]', 'bg-[#000]', 'p-[0]', 'focus:[outline:none]'], combo: true });
  // `#w-node-abc.cell` is an id selector with a trailing class (SPEC §4.3): its declarations join the id one-off.
  assert.deepEqual(model.ids.get('w-node-abc'), ['[grid-area:span_1_/_span_2]', 'p-[1px]', 'max-lg:[grid-column:span_2]']);
  assert.deepEqual(model.classes.get('bg'), { ref: { key: 'wf:bg', name: 'bg', classes: [] }, boundBackground: true });
  assert.ok(model.boundBackgroundKeys.has('bg'));
  assert.deepEqual(model.classes.get('evil')!.ref.classes, [], 'expression() and values carrying markup are dropped');
  assert.deepEqual([...model.tags.keys()].sort(), ['a', 'h1', 'p']);
  assert.deepEqual(model.tags.get('p'), { key: 'wf-tag:p', name: 'Paragraph', classes: ['mb-[10px]'] });
  assert.deepEqual(model.tags.get('h1')!.classes, ['text-[40px]']);

  const reasons = model.residual.rules.map((r) => `${r.selector}|${r.reason}|${r.media ?? ''}`);
  assert.deepEqual(reasons, [
    '.card|media|(min-width:1280px)',
    '.card:focus-visible|pseudo|',
    '.card .inner|complex|',
    '.card|tiny|screen and (max-width:479px)',
    '.card.dark|tiny|screen and (max-width:479px)',
    '#w-node-abc|tiny|screen and (max-width:479px)',
    'a:visited|pseudo|',
    'html|complex|',
  ].sort((a, b) => reasons.indexOf(a) - reasons.indexOf(b)));
  assert.deepEqual([...model.residual.classNames].sort(), ['card', 'dark', 'inner']);
  assert.deepEqual([...model.residual.ids], ['w-node-abc']);

  const out = model.residualCss;
  assert.ok(out.includes('html .wf-card .wf-inner{margin:0;}'), out);
  assert.ok(!out.includes('wf-cell'), 'the id rule with a trailing class became a one-off, not residual');
  assert.ok(out.includes('html .wf-card:focus-visible{outline:1px solid red;}'), out);
  assert.ok(out.includes('html a:visited{color:red;}'), out);
  assert.ok(out.includes('html{font-size:calc(1rem + 1vw);}'), 'html rules are not scoped twice');
  assert.ok(out.includes('@media (max-width:479px){\nhtml .wf-card{padding:2px;}\nhtml .wf-card.wf-dark{padding:1px;}\nhtml #w-node-abc{grid-column:span 1;}\n}'), out);
  assert.ok(out.includes('@media (min-width:1280px){\nhtml .wf-card{padding:20px;}\n}'), out);
  assert.ok(out.includes('@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}'), out);
  assert.ok(!out.includes('<'), out);

  assert.deepEqual(model.fontFaces.map((f) => [f.family, f.weight, f.style, f.src]), [['Foo', '700', 'normal', '../fonts/foo.woff2']]);
  assert.deepEqual(model.fontFamilies, ['Neue Haas', 'Foo']);
  const summary = warn.summary();
  assert.equal(summary.css_residual, model.residual.rules.length);
  assert.equal(summary.css_dropped, 3);
  assert.equal(summary.css_neutralised, undefined, 'no markup reached the residual CSS');
  assert.equal(summary.asset_missing, undefined);

  const emitted = emittedClasses(model);
  const unexplained = [...emitted].filter((c) => !isExplainedClass(c));
  assert.deepEqual(unexplained, []);
  assert.ok(![...emitted].some((c) => /[<>]/.test(c)), 'no markup inside classes');
});

test('empty and framework-only input yields an empty model', () => {
  const warn = new Warnings();
  const model = buildStyleModel({ siteCss: [], assetUrl: NO_ASSETS, warn });
  assert.equal(model.classes.size, 0);
  assert.equal(model.residualCss, '');
  assert.deepEqual(model.fontFamilies, []);
  const two = buildStyleModel({ siteCss: ['.a{color:red}', '.a{color:blue}.b{display:grid}'], assetUrl: NO_ASSETS, warn });
  assert.deepEqual(two.classes.get('a')!.ref.classes, ['text-[blue]'], 'later sheets win');
  assert.deepEqual(two.classes.get('b')!.ref.classes, ['grid']);
});

const SAMPLE_CSS = path.join(process.cwd(), 'import/web/valeska-von-brase.webflow/css/valeska-von-brase.css');
const SAMPLE_ROOT = path.dirname(path.dirname(SAMPLE_CSS));

test('sample stylesheet: sizes, conversions, residual CSS and class hygiene', { skip: !existsSync(SAMPLE_CSS) }, () => {
  const css = readFileSync(SAMPLE_CSS, 'utf8');
  const warn = new Warnings();
  const assetUrl = (rel: string) => {
    const file = rel.replace(/^(\.\.\/|\.\/|\/)+/, '');
    return existsSync(path.join(SAMPLE_ROOT, file)) ? `/storage/v1/object/public/assets/website/${path.basename(file)}` : null;
  };
  const model = buildStyleModel({ siteCss: [css], assetUrl, warn });

  // Sizes. The sheet has 155 single classes, 59 distinct combo chains (57 with a
  // non-tiny rule) and 10 distinct `#w-node-*` ids; SPEC §4.6 quoted the rule
  // counts (94 combo rules, 23 id rules), not the unique keys.
  assert.ok(model.classes.size >= 140 && model.classes.size <= 170, `classes ${model.classes.size}`);
  assert.ok(model.combos.size >= 55 && model.combos.size <= 65, `combos ${model.combos.size}`);
  assert.equal(model.ids.size, 10);
  assert.deepEqual([...model.tags.keys()].sort(), ['a', 'p']);
  assert.ok(model.residual.rules.length >= 60 && model.residual.rules.length <= 200, `residual ${model.residual.rules.length}`);
  assert.equal(model.residual.rules.filter((r) => r.reason === 'tiny').length, 70);
  assert.ok(model.residualCss.length < 40_000);

  // Conversions.
  const section = model.classes.get('section')!.ref.classes;
  assert.ok(section.includes('flex') && section.includes('max-lg:p-[50px]'), section.join(' '));
  assert.ok(section.includes('flex-col'), 'flex-flow: column is expanded');
  assert.ok(model.classes.get('body')!.ref.classes.includes('font-[NeueHaas]'));
  const divBlock = model.classes.get('div-block')!;
  assert.equal(divBlock.boundBackground, true);
  assert.ok(!divBlock.ref.classes.some((c) => c.includes('bg-[url(')), divBlock.ref.classes.join(' '));
  assert.ok(divBlock.ref.classes.includes('hover:min-w-[300%]'));
  assert.ok(model.combos.get('section.feature')!.classes.includes('max-md:h-[80vw]'), 'the 767 value stays in max-md:');
  assert.ok(model.combos.get('section.feature')!.combo);
  assert.equal(model.combos.get('logoanimation.white.l')!.name, 'logoanimation white l');
  assert.ok(model.classes.get('brand')!.ref.classes.includes('hover:[transform:skew(-20deg)]'));
  const footerCell = model.ids.get('w-node-fa9dcfde-d94a-d9e5-8ccb-11292035f235-2035f231')!;
  assert.ok(footerCell.some((c) => c.startsWith('max-lg:[grid-area:')), footerCell.join(' '));
  const bgImage = [...model.classes.values()].flatMap((v) => v.ref.classes).filter((c) => c.includes('bg-[') && c.includes('url('));
  assert.ok(bgImage.length >= 4, `re-hosted background images: ${bgImage.join(' ')}`);
  assert.ok(bgImage.every((c) => c.includes('url(/storage/v1/object/public/assets/website/') && !c.includes('\'')), bgImage.join(' '));
  assert.equal(warn.count('asset_missing'), 0);

  // Residual CSS.
  assert.ok(model.residualCss.includes('@media (max-width:479px)'));
  assert.ok(model.residualCss.includes('.wf-topheader'));
  assert.ok(model.residualCss.includes('html .wf-section.wf-feature{height:100vw;}'), 'the 479 value of a combo stays faithful');
  assert.ok(model.residualCss.includes(':focus-visible'));
  const residualSheet = tokenizeCss(model.residualCss);
  assert.ok(residualSheet.rules.length >= model.residual.rules.length);
  for (const rule of residualSheet.rules) {
    const parsed = parseSelector(rule.selector);
    assert.ok(parsed.classes.length > 0 || parsed.id, `residual selector has a class or id: ${rule.selector}`);
    for (const cls of parsed.classes) assert.ok(cls.startsWith('wf-'), `namespaced: ${rule.selector}`);
    assert.ok(rule.selector.startsWith('html '), `scoped: ${rule.selector}`);
  }
  assert.ok(!model.residualCss.includes('<'));
  assert.ok(!/@import|expression\(|javascript:/i.test(model.residualCss));

  // Fonts.
  assert.deepEqual(model.fontFaces.map((f) => `${f.family} ${f.weight} ${f.style}`), ['Librecaslontext 400 normal', 'NeueHaas 400 normal', 'NeueHaas 300 normal']);
  assert.deepEqual(model.fontFamilies, ['Librecaslontext', 'NeueHaas']);

  // Class hygiene (SPEC D1): every emitted class is a Tailwind utility, an
  // arbitrary value or a prefixed one — never a raw Webflow class name.
  const sheet = tokenizeCss(css);
  const original = new Set<string>();
  for (const rule of sheet.rules) for (const c of parseSelector(rule.selector).classes) original.add(c);
  // (`.w-nav` lives in components.css, which is never parsed; the site sheet's own framework rules are `.w-layout-*`.)
  assert.ok(original.has('section') && original.has('w-layout-cell') && original.has('grid') && original.has('overflow-hidden'));
  const emitted = emittedClasses(model);
  assert.ok(emitted.size > 300, `emitted ${emitted.size}`);
  const unexplained = [...emitted].filter((c) => !isExplainedClass(c));
  assert.deepEqual(unexplained, [], 'every emitted class is a utility, an arbitrary value or a prefixed one');
  assert.ok(![...emitted].some((c) => /\s|['"]/.test(c)), 'no whitespace or quotes inside classes');
  assert.ok(![...emitted].some((c) => c.startsWith('wf-') || c.startsWith('w-nav') || c.startsWith('w-dyn')), 'residual / framework names never leak into styles');
  for (const name of ['section', 'body', 'navbar', 'topheader', 'fixed-menu_item', 'w-layout-cell', 'w-layout-layout', 'w-nav', 'collection-list', 'container']) {
    assert.ok(!emitted.has(name), `raw Webflow class name emitted: ${name}`);
  }
  // Names that are BOTH a Webflow class and a Tailwind utility (`grid`,
  // `overflow-hidden`) may only appear where a declaration produces them.
  const collisions = [...emitted].filter((c) => original.has(c));
  assert.deepEqual(collisions.sort(), ['grid', 'overflow-hidden']);
  const producible = new Map<string, Set<string>>();
  for (const rule of sheet.rules) {
    const parsed = parseSelector(rule.selector);
    if (parsed.kind !== 'class' && parsed.kind !== 'combo' && parsed.kind !== 'id') continue;
    const key = parsed.kind === 'id' ? `#${parsed.id}` : parsed.classes.join('.');
    const set = producible.get(key) ?? new Set<string>();
    for (const c of cssToClasses(rule.declarations.map((d) => `${d.prop}: ${d.value}`).join('; '))) set.add(c);
    producible.set(key, set);
  }
  const check = (key: string, classes: string[]) => {
    for (const cls of classes) {
      if (!collisions.includes(cls)) continue;
      assert.ok(producible.get(key)?.has(cls), `${key} emits ${cls} without a declaration producing it`);
    }
  };
  for (const [name, v] of model.classes) check(name, v.ref.classes);
  for (const [chain, ref] of model.combos) check(chain, ref.classes);
  for (const [id, classes] of model.ids) check(`#${id}`, classes);
  assert.ok(model.classes.get('overflow-hidden')!.ref.classes.includes('overflow-hidden'), 'produced by `overflow: hidden`');
  assert.ok(!model.classes.get('grid')!.ref.classes.includes('grid'), 'the Webflow class `.grid` has no display:grid');
});

test('a declaration that yields no utility class is counted in a css_dropped warning', () => {
  const warn = new Warnings();
  // `background-clip: text` is deliberately skipped by upstream's converter and
  // `speak` has no Tailwind mapping and no arbitrary fallback worth emitting.
  const model = buildStyleModel({
    siteCss: ['.quiet { background-clip: text; color: #111 }'],
    assetUrl: () => null,
    warn,
  });
  assert.deepEqual(model.classes.get('quiet')!.ref.classes, ['text-[#111]']);
  const dropped = warn.list.filter((w) => w.code === 'css_dropped');
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].message, /background-clip on \.quiet produced no utility class/);
});

test('a value containing a semicolon does not corrupt the declaration after it', () => {
  const warn = new Warnings();
  const model = buildStyleModel({
    siteCss: ['.d { background-image: url("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="); color: #222 }'],
    assetUrl: () => null,
    warn,
  });
  const classes = model.classes.get('d')!.ref.classes;
  assert.ok(classes.includes('text-[#222]'), `colour survived: ${classes.join(' ')}`);
  assert.equal(warn.count('css_dropped'), 0);
});

test('framework sheets contribute tag defaults only — no class styles, no residual', () => {
  const warn = new Warnings();
  const model = buildStyleModel({
    frameworkCss: [`
      h1 { font-size: 38px; line-height: 44px; margin-top: 20px }
      p { margin-top: 0; margin-bottom: 10px }
      .w-nav { position: relative; z-index: 1000 }
      .w-richtext:after { content: ' '; display: table }
      @media (max-width: 479px) { h1 { font-size: 30px } }
    `],
    siteCss: ['h1 { color: #111 } .hero { padding: 10px }'],
    assetUrl: () => null,
    warn,
  });

  const h1 = model.tags.get('h1')!;
  assert.ok(h1.classes.includes('text-[38px]'), `h1 size: ${h1.classes.join(' ')}`);
  assert.ok(h1.classes.includes('leading-[44px]'));
  assert.ok(h1.classes.includes('text-[#111]'), 'the site sheet still overrides the framework default');
  assert.ok(model.tags.get('p')!.classes.includes('mb-[10px]'));

  // Nothing framework-side leaks into classes or the residual stylesheet.
  assert.equal(model.classes.has('w-nav'), false);
  assert.equal(model.classes.has('w-richtext'), false);
  assert.deepEqual([...model.classes.keys()], ['hero']);
  assert.equal(model.residual.rules.length, 0);
  assert.equal(model.residualCss.trim(), '');
  assert.equal(warn.count('css_residual'), 0);
});

test('a border reset in a tag rule or a class becomes border-0, which a real border evicts', () => {
  const warn = new Warnings();
  const model = buildStyleModel({
    frameworkCss: ['button, [type="button"], [type="reset"] { border: 0; cursor: pointer; -webkit-appearance: button; } img { border: 0; }'],
    siteCss: ['.video-control { border: 1px solid #fff; } .flat { border: none; } .card:hover { border: 0; }'],
    assetUrl: NO_ASSETS,
    warn,
  });
  const button = model.tags.get('button')!;
  assert.ok(button.classes.includes('border-0'), button.classes.join(' '));
  assert.ok(!button.classes.some((c) => c.startsWith('[border:')), 'no arbitrary border property');
  assert.ok(model.tags.get('img')!.classes.includes('border-0'));
  assert.deepEqual(model.classes.get('flat')!.ref.classes, ['border-none'], 'upstream already maps `border: none` to a real utility');
  assert.deepEqual(model.classes.get('card')!.ref.classes, ['hover:border-0']);
  // Stacked under a designed border the reset disappears instead of winning in the stylesheet.
  const stacked = mergePrefixedClasses([...button.classes, ...model.classes.get('video-control')!.ref.classes]);
  assert.ok(!stacked.includes('border-0'), stacked.join(' '));
  assert.ok(stacked.includes('border-[1px]') && stacked.includes('border-solid') && stacked.includes('border-[#fff]'));
  assert.ok(getAffectedProperties('border-0').includes('borderWidth'));
});

test('font-weight keywords become numeric weights (never a font-[bold] "family"), in every variant', () => {
  const warn = new Warnings();
  const decls = tokenizeCss('.h { font-weight: bold; color: #111 }').rules[0].declarations;
  assert.equal(normaliseDeclarations(decls, {}, NO_ASSETS, warn).css, 'font-weight: 700; color: #111');
  const model = buildStyleModel({
    siteCss: [
      '.h { font-weight: bold } .n { font-weight: normal } .b { font-weight: bolder } .l { font-weight: lighter } .s { font-weight: 600 } .u { font-weight: BOLD }',
      '.x { font-weight: 400 } .x:hover { font-weight: bold } @media screen and (max-width: 991px) { .x { font-weight: bold } }',
    ],
    assetUrl: NO_ASSETS,
    warn,
  });
  const of = (name: string) => model.classes.get(name)!.ref.classes;
  assert.deepEqual(of('h'), ['font-[700]']);
  assert.deepEqual(of('n'), ['font-[400]']);
  assert.deepEqual(of('b'), ['font-[700]']);
  assert.deepEqual(of('l'), ['font-[300]']);
  assert.deepEqual(of('s'), ['font-[600]'], 'numeric weights pass through');
  assert.deepEqual(of('u'), ['font-[700]'], 'case-insensitive');
  assert.deepEqual(of('x'), ['font-[400]', 'max-lg:font-[700]', 'hover:font-[700]']);
  for (const cls of emittedClasses(model)) assert.ok(!/font-\[(bold|normal|bolder|lighter)\]/i.test(cls), cls);
  // The repair also catches a class upstream's converter emits on its own.
  assert.equal(repairFontWeightClass('font-[bold]'), 'font-[700]');
  assert.equal(repairFontWeightClass('max-lg:hover:font-[normal]'), 'max-lg:hover:font-[400]');
  assert.equal(repairFontWeightClass('font-[Gelasio_Regular]'), 'font-[Gelasio_Regular]', 'a family is left alone');
  assert.equal(repairFontWeightClass('font-[700]'), 'font-[700]');
  // Design data: the numeric class is a weight for the design panel, the keyword class would have been a family.
  assert.deepEqual(getAffectedProperties('font-[700]'), ['fontWeight']);
  assert.deepEqual(getAffectedProperties('font-[bold]'), ['fontFamily']);
  assert.equal(buildDesign('font-[700]')?.typography?.fontWeight, '700');
  assert.equal(buildDesign('font-[700]')?.typography?.fontFamily, undefined);
  assert.equal(FONT_WEIGHT_KEYWORDS.bold, '700');
});

test('descendant tag rules of rich-text containers become richTextTags, not residual CSS', () => {
  const warn = new Warnings();
  const model = buildStyleModel({
    frameworkCss: [`
      p { margin-top: 0; margin-bottom: 10px }
      .w-richtext ol, .w-richtext ul { overflow: hidden }
      .w-richtext figure { position: relative; max-width: 60% }
      .w-richtext figure img { width: 100% }
      .w-richtext figure.w-richtext-align-center { margin-left: auto }
    `],
    siteCss: [`
      .rich-text-block p { margin-bottom: 24px }
      .rich-text-block > h2 { font-size: 40px }
      .rich-text-block a:hover { color: #f00 }
      @media (max-width: 991px) { .rich-text-block p { margin-bottom: 16px } }
      @media (max-width: 479px) { .rich-text-block p { margin-bottom: 8px } }
      .hero p { margin-bottom: 0 }
      .rich-text-block .note { color: #999 }
    `],
    richTextClasses: ['rich-text-block'],
    assetUrl: () => null,
    warn,
  });

  const wf = model.richTextTags!.get('w-richtext')!;
  assert.deepEqual(wf.get('ul'), ['overflow-hidden']);
  assert.deepEqual(wf.get('ol'), ['overflow-hidden']);
  assert.deepEqual(wf.get('figure'), ['relative', 'max-w-[60%]']);
  assert.deepEqual(wf.get('img'), ['w-full'], 'the last tag of `.w-richtext figure img` is the key');

  const block = model.richTextTags!.get('rich-text-block')!;
  assert.deepEqual(block.get('p'), ['mb-[24px]', 'max-lg:mb-[16px]'], 'breakpoints become variants, tiny stays residual');
  assert.deepEqual(block.get('h2'), ['text-[40px]'], 'child combinator is fine');
  assert.deepEqual(block.get('a'), ['hover:text-[#f00]'], 'a trailing state pseudo becomes a variant');

  const residual = model.residual.rules.map((r) => `${r.selector} (${r.reason})`);
  assert.deepEqual(residual, ['.rich-text-block p (tiny)', '.hero p (complex)', '.rich-text-block .note (complex)']);
  assert.ok(!model.residual.classNames.has('w-richtext'));
  assert.equal(model.classes.has('w-richtext'), false, 'framework classes still yield no layer style');
  assert.equal(model.tags.get('p')!.classes.join(' '), 'mt-[0] mb-[10px]');
});

test('richTextDescendantScope accepts only `.scope tag…` chains of known rich-text tags', () => {
  const scopes = new Set(['rich-text-block']);
  const scopeOf = (sel: string) => richTextDescendantScope(parseSelector(sel), scopes);
  assert.equal(scopeOf('.w-richtext p'), 'w-richtext');
  assert.equal(scopeOf('.w-richtext ol li'), 'w-richtext');
  assert.equal(scopeOf('.rich-text-block > blockquote'), 'rich-text-block');
  assert.equal(scopeOf('.rich-text-block a:focus'), 'rich-text-block');
  assert.equal(scopeOf('.hero p'), null, 'not a rich-text container');
  assert.equal(scopeOf('.w-richtext .note'), null, 'class descendant');
  assert.equal(scopeOf('.w-richtext div'), null, 'tag ycode has no text style for');
  assert.equal(scopeOf('.w-richtext.dark p'), null, 'combo scope');
  assert.equal(scopeOf('.w-richtext p::before'), null, 'pseudo element');
  assert.equal(scopeOf('.w-richtext p + p'), null, 'sibling combinator');
  assert.equal(scopeOf('#main p'), null);
});

test('state combos: `w--current` -> current: variant on the chip; w--open / tab-active / data-nav-menu-open -> state rules per chain; dead rules dropped with css_state_dropped', () => {
  const warn = new Warnings();
  const css = `
.dropdown-list{position:relative}
.dropdown-list.w--open{background-color:#fff;padding:20px}
.dropdown-toggle{background-color:#000;padding:30px 0}
.dropdown-toggle.w--open{background-color:#333;color:#fff;transform:rotate(180deg)}
.nav-link.w--current{color:#0082f3}
.nav-link.black.w--current{color:#fff}
.nav-menu[data-nav-menu-open]{background-color:#111}
.tab-pane.w--tab-active{opacity:1}
.w--open{color:red}
.toggle.w--open:hover{color:blue}
@media screen and (max-width:767px){.dropdown-list.w--open{padding:10px}.nav-link.w--current{color:#000}}
@media screen and (max-width:479px){.dropdown-list.w--open{padding:5px}}
`;
  const model = buildStyleModel({ siteCss: [css], assetUrl: () => null, warn });

  // No combo chip for a state class (it would never match an element).
  assert.deepEqual([...model.combos.keys()], ['nav-link.black']);
  assert.deepEqual(model.classes.get('dropdown-list')!.ref.classes, ['relative'], 'the open styles are not merged at CSS level (html.ts decides per role)');
  const list = model.states.get('dropdown-list')!;
  assert.deepEqual(list.map((r) => [r.state, r.selector, r.breakpoint, r.classes]), [
    ['w--open', '.dropdown-list.w--open', 'main', ['bg-[#fff]', 'p-[20px]']],
    ['w--open', '.dropdown-list.w--open', 'small', ['max-md:p-[10px]']],
  ]);
  assert.deepEqual(list[0].declarations.map((d) => `${d.prop}:${d.value}`), ['background-color:#fff', 'padding:20px']);
  assert.deepEqual(list[1].declarations, [], 'a breakpoint rule carries no declarations for the tween path');

  const toggle = model.states.get('dropdown-toggle')!;
  assert.equal(toggle.length, 1);
  assert.deepEqual(toggle[0].declarations.map((d) => `${d.prop}:${d.value}`), ['background-color:#333', 'color:#fff', 'transform:rotate(180deg)']);
  assert.deepEqual(model.resting.get('dropdown-toggle')!.map((d) => `${d.prop}:${d.value}`), ['background-color:#000', 'padding:30px 0']);

  // `w--current` is ycode's `current:` variant (aria-current="page"), breakpoints first —
  // and a state rule per chain as well, so html.ts can route it on a tab link (states.ts).
  assert.deepEqual(model.classes.get('nav-link')!.ref.classes, ['current:text-[#0082f3]', 'max-md:current:text-[#000]']);
  assert.deepEqual(model.combos.get('nav-link.black')!.classes, ['current:text-[#fff]']);
  assert.deepEqual(model.states.get('nav-link')!.map((r) => [r.state, r.selector, r.breakpoint, r.classes]), [
    ['w--current', '.nav-link.w--current', 'main', ['text-[#0082f3]']],
    ['w--current', '.nav-link.w--current', 'small', ['max-md:text-[#000]']],
  ]);
  assert.deepEqual(model.states.get('nav-link')![0].declarations.map((d) => `${d.prop}:${d.value}`), ['color:#0082f3']);
  assert.deepEqual(model.states.get('nav-link.black')!.map((r) => [r.state, r.classes]), [['w--current', ['text-[#fff]']]]);

  assert.deepEqual(model.states.get('nav-menu')!.map((r) => [r.state, r.selector, r.classes]), [['w--nav-menu-open', '.nav-menu[data-nav-menu-open]', ['bg-[#111]']]]);
  assert.ok(model.classes.has('nav-menu'), 'the chip the open styles merge into exists even without a rule of its own');
  assert.deepEqual(model.states.get('tab-pane')!.map((r) => [r.state, r.classes]), [['w--tab-active', ['opacity-[1]']]]);
  assert.ok(!model.residual.rules.some((r) => r.selector.includes('w--') || r.selector.includes('data-nav-menu-open')), 'no state rule reaches the residual CSS');

  const dropped = warn.list.filter((w) => w.code === 'css_state_dropped').map((w) => w.message);
  assert.deepEqual(dropped, [
    ".w--open: the rule selects only Webflow's runtime state class, which no element of the export carries",
    '.toggle.w--open:hover: a state class combined with :hover has no ycode variant',
    '.dropdown-list.w--open: state rule inside a media query ycode has no tier for ((max-width:479px))',
  ]);
});

test('bodyClassesFor: body tag rule, then the body classes; a body class the residual CSS still selects keeps its wf- hook', () => {
  const warn = new Warnings();
  const css = `
body{margin:0;background-color:#fff}
.body{letter-spacing:1px;font-size:24px;line-height:26px}
.plain{color:#333}
@media screen and (max-width:479px){.body{font-size:18px;line-height:20px}}
`;
  const model = buildStyleModel({ siteCss: [css], assetUrl: () => null, warn });
  assert.ok(model.residual.classNames.has('body'), 'the tiny rule of .body is residual CSS');
  assert.ok(!model.residual.classNames.has('plain'));
  const classes = bodyClassesFor(['body', 'plain'], model).split(' ');
  for (const c of ['m-[0]', 'bg-[#fff]', 'tracking-[1px]', 'text-[24px]', 'leading-[26px]', 'text-[#333]', 'wf-body']) assert.ok(classes.includes(c), `${c} in ${classes.join(' ')}`);
  assert.ok(!classes.includes('wf-plain'), 'no hook without a residual rule');
  assert.ok(model.residualCss.includes('html .wf-body{font-size:18px;line-height:20px;}'), model.residualCss);
  assert.equal(bodyClassesFor([], model).includes('wf-body'), false);
});

test('combo precedence: a base-class breakpoint rule never overrides a combo declaration of the same property', () => {
  const warn = new Warnings();
  const css = `
.section{padding:60px 20px;display:flex;border-top:1px #000}
.section.small{padding:10px 20px;border-top-style:solid}
.section.text{padding:0}
.card{margin:4px;color:#111}
.card.dark{color:#fff}
.card.dark.wide{margin-top:2px}
.box{padding:5px}
.box.pad{padding:1px}
.button{max-width:16rem;border:1px solid #006450}
.heading-2{font-weight:300}
.heading-2.button{max-width:20rem}
@media screen and (max-width:991px){.section{padding:50px}.card{margin:8px}.card.dark{color:#eee}.box.pad{padding-top:7px}}
@media screen and (max-width:767px){.card{color:#222}.button{max-width:15rem}.heading-2.button{font-size:20px;line-height:24px}.box{padding:9px}}
@media screen and (max-width:479px){.section{padding:20px 10px 50px}.section.text{padding:3px}.heading-2{font-size:30px;line-height:30px}.box{padding:2px !important}}
`;
  const model = buildStyleModel({ siteCss: [css], assetUrl: NO_ASSETS, warn });
  const combo = (chain: string) => model.combos.get(chain)!.classes;

  // Re-stated on 991 px, where `.section` sets padding; nothing on 767 px (no base rule there).
  assert.deepEqual(combo('section.small').filter((c) => c.startsWith('max-')), ['max-lg:pt-[10px]', 'max-lg:pr-[20px]', 'max-lg:pb-[10px]', 'max-lg:pl-[20px]']);
  // Only the conflicting property: `.card`'s 991 px margin does not touch color, its 767 px colour does.
  // The re-stated value is the combo's narrowest one above that breakpoint (`#eee` from 991 px, not `#fff`).
  assert.deepEqual(combo('card.dark'), ['max-md:text-[#eee]', 'text-[#fff]', 'max-lg:text-[#eee]'], 'no margin: the combo never sets it');
  // A longer combo also outranks the shorter one it extends.
  assert.ok(combo('card.dark.wide').includes('max-lg:mt-[2px]'), combo('card.dark.wide').join(' '));
  // A combo's own breakpoint longhand stays after (and refines) the re-stated shorthand.
  const pad = combo('box.pad');
  assert.ok(pad.includes('max-md:p-[1px]') && pad.includes('max-lg:pt-[7px]'), pad.join(' '));
  // A standalone class of the chain counts as well: `.button`'s 767 px max-width loses to `.heading-2.button`.
  assert.ok(combo('heading-2.button').includes('max-md:max-w-[20rem]'), combo('heading-2.button').join(' '));
  assert.deepEqual(model.classes.get('section')!.ref.classes.filter((c) => c.startsWith('max-')), ['max-lg:p-[50px]'], 'the base chip is untouched');

  // Under 480 px there is no tier: the combo's effective values for the tiny rule's properties
  // become a derived residual rule, whose two classes outrank `html .wf-section`.
  const tiny = model.residual.rules.filter((r) => r.reason === 'combo').map((r) => `${r.selector}{${r.block}}`);
  assert.deepEqual(tiny.sort(), [
    '.heading-2.button{font-size:20px;line-height:24px;}',
    '.section.small{padding:10px 20px;}',
  ]);
  assert.ok(model.residualCss.includes('html .wf-section.wf-small{padding:10px 20px;}'), model.residualCss);
  // `.section.text` has its own tiny padding (later in the residual CSS, same weight): nothing derived.
  // `.box` tiny padding is `!important`: it keeps winning over the combo, as in Webflow.
  assert.ok(!tiny.some((r) => r.startsWith('.section.text') || r.startsWith('.box.pad')), tiny.join('\n'));
  assert.ok(model.residual.classNames.has('small') && model.residual.classNames.has('button'), 'the derived rules have their hooks');
  assert.equal(warn.count('css_residual'), model.residual.rules.filter((r) => r.reason !== 'combo').length, 'derived rules are not reported as verbatim residual CSS');
  assert.ok(model.order!.get('button')! < model.order!.get('heading-2')!, 'stylesheet positions for the chip order');
});

test('state variants keep winning under 480 px: restated as residual rules of their own selector over the tiny rules under them', () => {
  const warn = new Warnings();
  const css = `
.nav-link{color:#000}
.nav-link.white{color:#fff}
.nav-link.white.w--current{color:red}
.nav-link.white:hover{color:blue;background-color:#eee}
.link{color:#000}
.link:hover{color:green;background-color:#eee}
.quiet:hover{color:green}
.strong:hover{color:green}
@media screen and (max-width:767px){.link:hover{color:olive}}
@media screen and (max-width:479px){.nav-link{color:#333}.link{color:#333}.strong{color:#333 !important}.nav-link.white:hover{color:pink}}
`;
  const model = buildStyleModel({ siteCss: [css], classLists: ['nav-link white', 'link', 'quiet', 'strong'], assetUrl: NO_ASSETS, warn });
  // The chips keep their variants (the tiers above 480 px are untouched).
  assert.deepEqual(model.combos.get('nav-link.white')!.classes, ['text-[#fff]', 'hover:text-[blue]', 'hover:bg-[#eee]', 'current:text-[red]']);
  const derived = model.residual.rules.filter((r) => r.reason === 'combo').map((r) => `${r.selector}{${r.block}}`);
  assert.deepEqual(derived, [
    '.nav-link.white{color:#fff;}',
    // In Webflow `.nav-link.white:hover` / `.nav-link.white.w--current` (three) beat the combo's
    // derived rule (two) and the tiny `.nav-link` (one); `current:` is ycode's `[aria-current]`.
    '.nav-link.white:hover{color:blue;}',
    '.nav-link.white[aria-current]{color:red;}',
    // A single class too: `.link:hover` beats the tiny `.link`, with its narrowest value above 480 px.
    '.link:hover{color:olive;}',
  ], 'only what a tiny rule touches (no background), nothing against an !important tiny declaration, nothing without a tiny rule');
  const tinyGroup = model.residualCss.slice(model.residualCss.indexOf('@media (max-width:479px)'));
  const at = (rule: string) => {
    const i = tinyGroup.indexOf(rule);
    assert.ok(i >= 0, `${rule} missing in\n${tinyGroup}`);
    return i;
  };
  assert.ok(at('html .wf-nav-link.wf-white[aria-current]{color:red;}') < at('html .wf-nav-link{color:#333;}'));
  // The combo's own tiny hover rule is verbatim, later and as specific: it still wins.
  assert.ok(at('html .wf-nav-link.wf-white:hover{color:blue;}') < at('html .wf-nav-link.wf-white:hover{color:pink;}'));
  assert.ok(model.residual.classNames.has('link') && model.residual.classNames.has('white'), 'the derived rules have their hooks');
  assert.equal(warn.count('css_residual'), model.residual.rules.filter((r) => r.reason !== 'combo').length, 'derived rules are not reported as verbatim residual CSS');
});

test('a combo longhand beats the base class\'s per-side border shorthand (longhands, evicted per property in the layer stack)', () => {
  const model = buildStyleModel({ siteCss: ['.section{border-top:1px #000;border-bottom:2px dashed rgba(0, 0, 0, .5)}.section.small{border-top-style:solid}.plain{border-left-width:3px}'], assetUrl: NO_ASSETS, warn: new Warnings() });
  const base = model.classes.get('section')!.ref.classes;
  assert.deepEqual(base, [
    '[border-top-width:1px]', '[border-top-style:none]', '[border-top-color:#000]',
    '[border-bottom-width:2px]', '[border-bottom-style:dashed]', '[border-bottom-color:rgba(0,_0,_0,_.5)]',
  ]);
  const small = model.combos.get('section.small')!.classes;
  assert.deepEqual(small, ['[border-top-style:solid]']);
  const stack = dropShadowedClasses([...base, ...small].join(' ')).split(' ');
  assert.ok(stack.includes('[border-top-style:solid]') && !stack.includes('[border-top-style:none]'), stack.join(' '));
  assert.ok(stack.includes('[border-top-width:1px]') && stack.includes('[border-top-color:#000]'));
  // A side width alone never switches the style on (`border-l-[3px]` would, through --tw-border-style).
  assert.deepEqual(model.classes.get('plain')!.ref.classes, ['[border-left-width:3px]']);
  assert.deepEqual(expandBorderSide('border-top', 'solid'), [
    { prop: 'border-top-width', value: 'medium', important: false },
    { prop: 'border-top-style', value: 'solid', important: false },
    { prop: 'border-top-color', value: 'currentcolor', important: false },
  ]);
  assert.equal(expandBorderSide('border-top', 'var(--b)'), null);
  assert.equal(expandBorderSide('border', '1px solid #000'), null);
});

test('state classes inside complex selectors are translated into residual CSS ycode renders, or reported — never kept verbatim', () => {
  const warn = new Warnings();
  const css = `
.dropdown-list.w--open .dropdown-link{color:#000}
.nav .nav-link.w--current{color:red}
.w-locales-item a.w--current{color:#fff}
.dropdown-toggle.w--open .icon{transform:rotate(180deg)}
.w-nav-button.w--open .icon{color:#fff}
.navbar.w--open .nav-link{color:blue}
.ghost.w--open .x{color:green}
.tab-pane.w--tab-active > .inner{opacity:1}
.menu[data-nav-menu-open] .link{color:#333}
.a.w--open .b.w--open{color:#444}
@media screen and (max-width:479px){.nav .nav-link.w--current{color:pink}}
`;
  const classLists = ['dropdown-list w-dropdown-list', 'dropdown-link w-dropdown-link', 'dropdown-toggle w-dropdown-toggle', 'icon', 'w-nav-button', 'navbar w-nav', 'nav', 'nav-link w-nav-link', 'tab-pane w-tab-pane', 'inner', 'menu w-nav-menu'];
  const model = buildStyleModel({ siteCss: [css], classLists, assetUrl: NO_ASSETS, warn });

  assert.deepEqual(model.residual.rules.map((r) => `${r.reason}|${r.selector}|${r.media ?? ''}`), [
    'state|.dropdown-list .dropdown-link|',
    'state|.nav .nav-link[aria-current]|',
    'state|.w-locales-item a[aria-current]|',
    'state|.tab-pane > .inner|',
    'state|.nav .nav-link[aria-current]|screen and (max-width:479px)',
  ]);
  assert.ok(model.residualCss.includes('html .wf-dropdown-list .wf-dropdown-link{color:#000;}'), model.residualCss);
  assert.ok(model.residualCss.includes('html .wf-nav .wf-nav-link[aria-current]{color:red;}'), model.residualCss);
  assert.ok(model.residualCss.includes('html .wf-w-locales-item a[aria-current]{color:#fff;}'), model.residualCss);
  assert.ok(!model.residualCss.includes('w--'), 'no state class reaches the residual CSS');
  for (const c of ['dropdown-list', 'dropdown-link', 'nav', 'nav-link', 'w-locales-item', 'tab-pane', 'inner']) assert.ok(model.residual.classNames.has(c), `hook for ${c}`);
  assert.equal(warn.count('css_residual'), 0, 'translated state rules are not reported as verbatim residual CSS');

  const dropped = warn.list.filter((w) => w.code === 'css_state_dropped').map((w) => w.message);
  assert.deepEqual(dropped, [
    '.dropdown-toggle.w--open .icon: the open dropdown-toggle styles its descendants or surroundings here, and ycode has no open state for them (interaction tweens change the dropdown-toggle itself only)',
    '.w-nav-button.w--open .icon: the open nav-button styles its descendants or surroundings here, and ycode has no open state for them (interaction tweens change the nav-button itself only)',
    '.navbar.w--open .nav-link: .navbar is not a Webflow dropdown or nav element on every page, so webflow.js never sets .w--open there and the rule cannot lose it',
    '.ghost.w--open .x: no element of the export carries .ghost',
    '.menu[data-nav-menu-open] .link: the open nav menu inside a descendant selector has no ycode counterpart (the menu opens through the navbar interaction)',
    '.a.w--open .b.w--open: more than one Webflow state class in one selector has no ycode counterpart',
  ]);
  // Without the export's class lists only `w--current` can be translated.
  const bare = new Warnings();
  const withoutLists = buildStyleModel({ siteCss: ['.dropdown-list.w--open .dropdown-link{color:#000}'], assetUrl: NO_ASSETS, warn: bare });
  assert.equal(withoutLists.residual.rules.length, 0);
  assert.equal(bare.count('css_state_dropped'), 1);
  assert.equal(contextualStateOf('.a .b', []), null);
});

test('a state rule on a framework class is kept for html.ts without an empty chip; a mixed chain is reported', () => {
  const warn = new Warnings();
  const model = buildStyleModel({
    siteCss: ['.w-dropdown-toggle.w--open{color:blue;opacity:.5}.dropdown-toggle.w-dropdown-toggle.w--open{color:red}.w-dropdown-link.w--current{color:#0082f3}'],
    assetUrl: NO_ASSETS,
    warn,
  });
  assert.deepEqual(model.states.get('w-dropdown-toggle')!.map((r) => [r.state, r.classes]), [['w--open', ['text-[blue]', 'opacity-[.5]']]]);
  assert.ok(!model.classes.has('w-dropdown-toggle'), 'no chip entry named after the framework class');
  assert.deepEqual(model.classes.get('w-dropdown-link')!.ref.classes, ['current:text-[#0082f3]'], 'current: still reaches the framework classes (html.ts)');
  assert.deepEqual(warn.list.filter((w) => w.code === 'css_state_dropped').map((w) => w.message), [
    '.dropdown-toggle.w-dropdown-toggle.w--open: a state rule on a chain of several framework classes, or of site and framework classes, has no ycode counterpart',
  ]);
});

test('font stacks: the first family is the class, the fallbacks are kept per family for the font row', () => {
  assert.deepEqual(fontStackOf('NeueHaas, Arial, sans-serif'), { family: 'NeueHaas', fallback: 'Arial, sans-serif' });
  assert.deepEqual(fontStackOf('"Neue, Haas", \'Helvetica Neue\',serif'), { family: 'Neue, Haas', fallback: '\'Helvetica Neue\', serif' });
  assert.deepEqual(fontStackOf('Librecaslontext'), { family: 'Librecaslontext', fallback: '' });
  const model = buildStyleModel({ siteCss: [':root{--f:NeueHaas, Arial, sans-serif}.a{font-family:var(--f)}.b{font-family:NeueHaas, Verdana}.c{font-family:Solo}'], assetUrl: NO_ASSETS, warn: new Warnings() });
  assert.deepEqual([...model.fontFallbacks!], [['neuehaas', 'Arial, sans-serif']], 'first stack wins; a single family has none');
  assert.deepEqual(model.classes.get('a')!.ref.classes, ['font-[NeueHaas]']);
});

test('font fallback stacks that could leave the <style> element are never stored', () => {
  const warn = new Warnings();
  const model = buildStyleModel({
    siteCss: ['.a{font-family: NeueHaas, "x}</style><img src=x onerror=alert(1)>", sans-serif}.b{font-family: Other, "a;b"}.c{font-family: Fine, "Helvetica Neue", Arial, sans-serif}'],
    assetUrl: NO_ASSETS,
    warn,
  });
  assert.equal(model.fontFallbacks!.get('neuehaas'), undefined);
  assert.equal(model.fontFallbacks!.get('other'), undefined);
  assert.equal(model.fontFallbacks!.get('fine'), '"Helvetica Neue", Arial, sans-serif');
  assert.ok(warn.count('css_dropped') >= 2);
  assert.equal(safeFontFallback('Arial, sans-serif'), 'Arial, sans-serif');
  assert.equal(safeFontFallback("'Segoe UI', Roboto"), "'Segoe UI', Roboto");
  for (const bad of ['"x}</style>", serif', 'a;b', 'a{b', 'x</style>', '"a\\"b"', '"a\nb"', 'serif !important']) {
    assert.equal(safeFontFallback(bad), null, bad);
  }
  assert.equal(isSafeFontFamilyName('Neue Haas'), true);
  assert.equal(isSafeFontFamilyName('x"}</style>'), false);
  assert.equal(isSafeFontFamilyName('a\nb'), false);
});

test('combo lift: arbitrary-property longhands conflict by CSS property (per-side border longhands)', () => {
  assert.deepEqual(liftComboOverBreakpoints(['[border-top-style:solid]'], ['max-md:[border-top-style:none]']), ['max-md:[border-top-style:solid]', '[border-top-style:solid]']);
  // A regular utility of the lower chip that touches the property counts too.
  assert.ok(liftComboOverBreakpoints(['[border-top-style:solid]'], ['max-lg:border-dashed']).includes('max-lg:[border-top-style:solid]'));
  assert.deepEqual(liftComboOverBreakpoints(['[border-top-style:solid]'], ['max-md:[border-top-width:2px]']), ['[border-top-style:solid]'], 'another longhand is left alone');
  const model = buildStyleModel({ siteCss: ['.s{border-top:1px #000} @media (max-width:767px){.s{border-top:2px none #000}} .s.c{border-top-style:solid}'], assetUrl: NO_ASSETS, warn: new Warnings() });
  const base = model.classes.get('s')!.ref.classes;
  const combo = model.combos.get('s.c')!.classes;
  assert.ok(base.includes('max-md:[border-top-style:none]'), base.join(' '));
  assert.ok(combo.includes('max-md:[border-top-style:solid]'), combo.join(' '));
  const stack = dropShadowedClasses([...base, ...combo].join(' ')).split(' ');
  assert.ok(stack.includes('max-md:[border-top-style:solid]') && !stack.includes('max-md:[border-top-style:none]'), stack.join(' '));
});

test('combo lift: re-stated values cascade widest source first, so a narrower longhand refines a wider shorthand', () => {
  // `.a.b { padding: 10px } @991 { .a.b { padding-left: 5px } }` over `.a`'s 767 px padding: Webflow gives 10px 10px 10px 5px there.
  const lifted = liftComboOverBreakpoints(['p-[10px]', 'max-lg:pl-[5px]'], ['p-[50px]', 'max-md:p-[20px]']);
  const md = lifted.filter((c) => c.startsWith('max-md:'));
  assert.deepEqual(md, ['max-md:p-[10px]', 'max-md:pl-[5px]']);
  // A shorthand re-stated for another longhand drags the combo's narrower overlapping value along.
  const dragged = liftComboOverBreakpoints(['p-[10px]', 'max-lg:pl-[5px]'], ['max-md:pt-[1px]']).filter((c) => c.startsWith('max-md:'));
  assert.deepEqual(dragged, ['max-md:p-[10px]', 'max-md:pl-[5px]']);
  // The same property on two breakpoints: the narrower one reaches the lower chip's breakpoint.
  assert.deepEqual(liftComboOverBreakpoints(['p-[10px]', 'max-lg:p-[20px]'], ['max-md:p-[50px]']).filter((c) => c.startsWith('max-md:')), ['max-md:p-[20px]']);
  // A narrower shorthand replaces a wider longhand.
  assert.deepEqual(liftComboOverBreakpoints(['pl-[5px]', 'max-lg:p-[10px]'], ['max-md:p-[50px]']).filter((c) => c.startsWith('max-md:')), ['max-md:p-[10px]']);
});

test('combo lift: a standalone class the combo\'s elements carry is a lower chip too (breakpoints and under 480 px)', () => {
  const css = '.h{padding:1px} .btn{color:red} @media (max-width:767px){.btn{padding:50px}} @media (max-width:479px){.btn{padding:3px}} .h.l{padding:10px}';
  const without = buildStyleModel({ siteCss: [css], assetUrl: NO_ASSETS, warn: new Warnings() });
  assert.deepEqual(without.combos.get('h.l')!.classes, ['p-[10px]'], 'no element lists: only the chain counts');
  const model = buildStyleModel({ siteCss: [css], classLists: ['h l btn', 'h l w-button', 'btn'], assetUrl: NO_ASSETS, warn: new Warnings() });
  assert.deepEqual(model.combos.get('h.l')!.classes, ['max-md:p-[10px]', 'p-[10px]']);
  const derived = model.residual.rules.filter((r) => r.reason === 'combo').map((r) => `${r.selector}{${r.block}}`);
  assert.deepEqual(derived, ['.h.l{padding:10px;}']);
  assert.ok(model.residualCss.includes('html .wf-h.wf-l{padding:10px;}'), model.residualCss);
});

test('a background colour and a gradient both survive: in one rule and across a base class and its combo', () => {
  const model = buildStyleModel({
    siteCss: ['.section{padding:60px 20px;background-color:#123}.section.shadow{background-color:#00000070;background-image:linear-gradient(249deg,#0006,#ffffff40 62%)}.plain{background-color:#fff}.plain.grad{background-image:linear-gradient(red,blue)}.g{background-image:linear-gradient(red,blue)}.g.c{background-color:#abc}'],
    assetUrl: NO_ASSETS,
    warn: new Warnings(),
  });
  const alone = buildStyleModel({ siteCss: ['.shadow{background-color:#00000070;background-image:linear-gradient(249deg,#0006,#ffffff40 62%)}'], assetUrl: NO_ASSETS, warn: new Warnings() });
  assert.deepEqual(alone.classes.get('shadow')!.ref.classes, ['[background-color:#00000070]', 'bg-[linear-gradient(249deg,#0006,#ffffff40_62%)]']);
  // Over a base colour, the combo's gradient is an arbitrary background-image as well.
  const shadow = model.combos.get('section.shadow')!.classes;
  assert.deepEqual(shadow, ['[background-color:#00000070]', '[background-image:linear-gradient(249deg,#0006,#ffffff40_62%)]']);
  // The layer stack: upstream's merge keeps both, and the combo's colour still replaces the base colour per layer.
  const stack = [...model.classes.get('section')!.ref.classes, ...shadow];
  const flattened = dropShadowedClasses(mergeClassStack(stack).join(' ')).split(' ');
  assert.ok(flattened.includes('[background-color:#00000070]') && !flattened.includes('bg-[#123]'), flattened.join(' '));
  assert.ok(flattened.some((c) => c.includes('linear-gradient(249deg')), flattened.join(' '));
  // Across chips: the combo's gradient / colour becomes the arbitrary property it is.
  assert.deepEqual(model.combos.get('plain.grad')!.classes, ['[background-image:linear-gradient(red,blue)]']);
  assert.deepEqual(model.combos.get('g.c')!.classes, ['[background-color:#abc]']);
  assert.ok(mergeClassStack([...model.classes.get('plain')!.ref.classes, ...model.combos.get('plain.grad')!.classes]).includes('bg-[#fff]'));
  assert.deepEqual(keepColourBesideGradient(['max-lg:bg-[#000]', 'bg-[#fff]', 'max-lg:bg-[radial-gradient(red,blue)]']), ['max-lg:[background-color:#000]', 'bg-[#fff]', 'max-lg:bg-[radial-gradient(red,blue)]'].map((c, i) => (i === 1 ? '[background-color:#fff]' : c)));
  assert.deepEqual(keepBackgroundLayersApart(['bg-[#fff]'], ['max-lg:bg-[linear-gradient(red,blue)]']), ['bg-[#fff]'], 'other variant: untouched');
});

test('dropShadowedClasses: a later shorthand drops earlier longhands of the same variant, never the other way round', () => {
  const layer = 'pt-[60px] pr-[20px] pb-[60px] pl-[20px] max-lg:pt-[40px] p-[0] rounded-tl-[4px] rounded-[0] mt-[5px]';
  assert.deepEqual(dropShadowedClasses(layer).split(' '), ['max-lg:pt-[40px]', 'p-[0]', 'rounded-[0]', 'mt-[5px]']);
  assert.equal(dropShadowedClasses('p-[0] pt-[5px]'), 'p-[0] pt-[5px]');
  assert.equal(dropShadowedClasses('text-[24px] text-[#fff]'), 'text-[24px] text-[#fff]');
  assert.equal(dropShadowedClasses('[background-color:#000] bg-[linear-gradient(red,blue)]'), '[background-color:#000] bg-[linear-gradient(red,blue)]');
  assert.equal(dropShadowedClasses('bg-[url(/s/a.webp)] bg-[linear-gradient(red,blue),url(/s/b.webp)]'), 'bg-[linear-gradient(red,blue),url(/s/b.webp)]');
  assert.equal(dropShadowedClasses('translate-y-[2px] translate-x-[1px] underline decoration-[#f00] line-through'), 'translate-y-[2px] translate-x-[1px] decoration-[#f00] line-through');
});
