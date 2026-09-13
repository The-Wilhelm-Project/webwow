import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cssToClasses } from '@/lib/import/css';
import { getAffectedProperties } from '@/lib/tailwind-class-mapper';
import { splitVariant } from '@/lib/layer-style-resolve';
import { parseSelector, tokenizeCss } from './css-tokenizer';
import { Warnings } from './warnings';
import {
  BOUND_BG_PLACEHOLDER,
  BREAKPOINT_PREFIX,
  STATE_PREFIX,
  buildStyleModel,
  mediaKey,
  mergePrefixedClasses,
  namespaceSelector,
  normaliseDeclarations,
  rewriteCssUrls,
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
  assert.deepEqual(mergePrefixedClasses(['[inset:0]', '[inset:1px]', '']), ['[inset:0]', '[inset:1px]'], 'unknown arbitrary properties are kept as-is');
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
  assert.deepEqual(model.combos.get('card.dark'), { key: 'wf:card.dark', name: 'card dark', classes: ['bg-[#000]', 'p-[0]', 'focus:[outline:none]'], combo: true });
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
