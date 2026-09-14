import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstUrl,
  parseDeclarations,
  parseMediaQuery,
  parseSelector,
  resolveVars,
  splitTopLevel,
  stripCssComments,
  tokenizeCss,
} from './css-tokenizer';

function shape(selector: string) {
  const p = parseSelector(selector);
  return { kind: p.kind, classes: p.classes, id: p.id, tag: p.tag, pseudo: p.pseudo };
}

test('parseSelector classifies the selector shapes a Webflow export uses', () => {
  assert.deepEqual(shape('.a'), { kind: 'class', classes: ['a'], id: undefined, tag: undefined, pseudo: [] });
  assert.deepEqual(shape('.a.b'), { kind: 'combo', classes: ['a', 'b'], id: undefined, tag: undefined, pseudo: [] });
  assert.deepEqual(shape('.logoanimation.white.l.auto'), { kind: 'combo', classes: ['logoanimation', 'white', 'l', 'auto'], id: undefined, tag: undefined, pseudo: [] });
  assert.deepEqual(shape('#w-node-x'), { kind: 'id', classes: [], id: 'w-node-x', tag: undefined, pseudo: [] });
  assert.deepEqual(shape('#w-node-_8d505578-d9e0.cell'), { kind: 'id', classes: ['cell'], id: 'w-node-_8d505578-d9e0', tag: undefined, pseudo: [] });
  assert.deepEqual(shape('p'), { kind: 'tag', classes: [], id: undefined, tag: 'p', pseudo: [] });
  assert.deepEqual(shape('.a:hover'), { kind: 'class', classes: ['a'], id: undefined, tag: undefined, pseudo: [':hover'] });
  assert.deepEqual(shape('.a.b:focus'), { kind: 'combo', classes: ['a', 'b'], id: undefined, tag: undefined, pseudo: [':focus'] });
  assert.deepEqual(shape('a:active'), { kind: 'tag', classes: [], id: undefined, tag: 'a', pseudo: [':active'] });
  assert.equal(shape('._2').kind, 'class');
  assert.deepEqual(shape('.Foo_Bar-1').classes, ['Foo_Bar-1']);
});

test('parseSelector reports everything the style model cannot express as complex', () => {
  assert.equal(shape('.a .b').kind, 'complex');
  assert.deepEqual(shape('.a .b').classes, ['a', 'b']);
  assert.equal(shape('.a > .b').kind, 'complex');
  assert.equal(shape('.a + .b').kind, 'complex');
  assert.equal(shape('.a~.b').kind, 'complex');
  assert.deepEqual(shape('.a::before'), { kind: 'complex', classes: ['a'], id: undefined, tag: undefined, pseudo: ['::before'] });
  assert.equal(shape('.a:before').kind, 'complex');
  assert.deepEqual(shape('a[href]'), { kind: 'complex', classes: [], id: undefined, tag: 'a', pseudo: [] });
  assert.equal(shape('.a:not(.b)').kind, 'complex');
  assert.deepEqual(shape('.a:not(.b)').pseudo, [':not(.b)']);
  assert.equal(shape('.a:focus-visible').kind, 'complex');
  assert.equal(shape('.a:nth-child(2n)').kind, 'complex');
  assert.equal(shape('a:visited').kind, 'complex');
  assert.equal(shape('.a:hover:focus').kind, 'complex');
  assert.equal(shape('.a:hover.b').kind, 'complex');
  assert.equal(shape('div.a').kind, 'complex');
  assert.equal(shape('*').kind, 'complex');
  assert.equal(shape(':root').kind, 'complex');
  assert.equal(shape('#a#b').kind, 'complex');
  // Descendant selectors still report the last compound's tag for diagnostics.
  assert.equal(shape('.w-nav a').tag, 'a');
});

test('media queries flatten to max/min width numbers and everything else stays raw', () => {
  const sheet = tokenizeCss(`
.a{color:red}
@media screen and (max-width: 991px){.a{color:blue}}
@media screen and (max-width: 767px){.a{color:green}}
@media screen and (max-width: 479px){.a{color:black}}
@media (min-width: 768px){.a{color:white}}
@media print{.a{display:none}}
@media (prefers-reduced-motion: reduce){.a{transition:none}}
@media screen and (max-width: 991px){@media (max-width: 767px){.nested{color:red}}}
`);
  const byValue = (v: string) => sheet.rules.find((r) => r.declarations.some((d) => d.value === v))!;
  assert.deepEqual([byValue('red').media, byValue('red').maxWidth, byValue('red').minWidth], [null, null, null]);
  assert.deepEqual([byValue('blue').media, byValue('blue').maxWidth, byValue('blue').minWidth], ['screen and (max-width: 991px)', 991, null]);
  assert.equal(byValue('green').maxWidth, 767);
  assert.equal(byValue('black').maxWidth, 479);
  assert.deepEqual([byValue('white').maxWidth, byValue('white').minWidth], [null, 768]);
  assert.deepEqual([byValue('none').media, byValue('none').maxWidth, byValue('none').minWidth], ['print', null, null]);
  assert.deepEqual([byValue('none').media, byValue('none').maxWidth], ['print', null]);
  const reduced = sheet.rules.find((r) => r.selector === '.a' && r.media?.includes('prefers'))!;
  assert.deepEqual([reduced.maxWidth, reduced.minWidth], [null, null]);
  const nested = sheet.rules.find((r) => r.selector === '.nested')!;
  assert.equal(nested.maxWidth, 767);
  assert.deepEqual(parseMediaQuery('only screen and (max-width:479px)'), { maxWidth: 479, minWidth: null });
  assert.deepEqual(parseMediaQuery('(min-width: 768px) and (max-width: 991px)'), { maxWidth: 991, minWidth: 768 });
  assert.deepEqual(parseMediaQuery('(max-width: 40em)'), { maxWidth: null, minWidth: null });
  assert.deepEqual(parseMediaQuery('screen and (orientation: landscape)'), { maxWidth: null, minWidth: null });
});

test('declarations split on top-level semicolons only (url and content values are safe)', () => {
  const sheet = tokenizeCss('.a{background:url(\'a;b\');content:";";font-family:"Neue Haas", Arial;color:red !important;--x: 1;bogus}');
  assert.equal(sheet.rules.length, 1);
  assert.deepEqual(sheet.rules[0].declarations, [
    { prop: 'background', value: 'url(\'a;b\')', important: false },
    { prop: 'content', value: '";"', important: false },
    { prop: 'font-family', value: '"Neue Haas", Arial', important: false },
    { prop: 'color', value: 'red', important: true },
    { prop: '--x', value: '1', important: false },
  ]);
  assert.deepEqual(parseDeclarations('COLOR: Red ! important'), [{ prop: 'color', value: 'Red', important: true }]);
  assert.deepEqual(parseDeclarations('width: ; height: 1px'), [{ prop: 'height', value: '1px', important: false }]);
  assert.deepEqual(splitTopLevel('a,b(c,d),"e,f",[g,h]', ','), ['a', 'b(c,d)', '"e,f"', '[g,h]']);
  assert.deepEqual(splitTopLevel('', ','), ['']);
  assert.deepEqual(splitTopLevel('a,,b', ','), ['a', '', 'b']);
});

test(':root custom properties are collected and resolveVars substitutes them recursively with fallbacks', () => {
  const sheet = tokenizeCss(`
:root{--c:#123456;--s:var(--c);--pad: 10px 20px}
@media (max-width:767px){:root{--c:#000}}
.a{color:var(--c)}
`);
  assert.deepEqual(sheet.rootVars, { '--c': '#123456', '--s': 'var(--c)', '--pad': '10px 20px' });
  // The :root inside @media is a rule (not a global variable).
  assert.ok(sheet.rules.some((r) => r.selector === ':root' && r.maxWidth === 767));
  const vars = sheet.rootVars;
  assert.equal(resolveVars('var(--c)', vars), '#123456');
  assert.equal(resolveVars('var(--s)', vars), '#123456');
  assert.equal(resolveVars('var(--missing, 10px)', vars), '10px');
  assert.equal(resolveVars('var(--missing, var(--c))', vars), '#123456');
  assert.equal(resolveVars('var(--missing)', vars), 'var(--missing)');
  assert.equal(resolveVars('calc(var(--pad) + 1px)', vars), 'calc(10px 20px + 1px)');
  assert.equal(resolveVars('--foo-var(1)', vars), '--foo-var(1)');
  // Self-referencing variables terminate (depth <= 5).
  assert.equal(resolveVars('var(--loop)', { '--loop': 'var(--loop)' }), 'var(--loop)');
});

test('@font-face, @import and @keyframes are extracted; selector lists are split', () => {
  const sheet = tokenizeCss(`
@import url("x.css");
@charset "utf-8";
@font-face {
  font-family: Librecaslontext;
  src: url('../fonts/libre.woff2') format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face{font-family:"Neue Haas";src:local("x"),url(../fonts/neue.ttf) format("truetype");font-weight:300;font-style:italic}
@font-face{font-family:NoSrc}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
@supports (display:grid){.g{display:grid}}
.a, .b:hover ,
.c .d{color:red}
h1,h2{margin:0}
`);
  assert.deepEqual(sheet.fontFaces.map((f) => ({ family: f.family, weight: f.weight, style: f.style, src: f.src, format: f.format })), [
    { family: 'Librecaslontext', weight: '400', style: 'normal', src: '../fonts/libre.woff2', format: 'woff2' },
    { family: 'Neue Haas', weight: '300', style: 'italic', src: '../fonts/neue.ttf', format: 'truetype' },
  ]);
  assert.ok(sheet.fontFaces[0].raw.startsWith('@font-face'));
  assert.deepEqual(sheet.atRules.map((a) => a.name), ['import', 'charset', 'keyframes', 'supports']);
  assert.equal(sheet.atRules[0].raw, '@import url("x.css");');
  assert.ok(sheet.atRules[2].raw.includes('rotate(360deg)'));
  const list = sheet.rules.filter((r) => r.declarations[0]?.value === 'red');
  assert.deepEqual(list.map((r) => r.selector), ['.a', '.b:hover', '.c .d']);
  assert.equal(new Set(list.map((r) => r.order)).size, 1, 'a selector list shares one order number');
  const headings = sheet.rules.filter((r) => r.declarations[0]?.prop === 'margin');
  assert.deepEqual(headings.map((r) => r.selector), ['h1', 'h2']);
  assert.ok(headings[0].order > list[0].order);
  assert.equal(firstUrl('local("x"), url( "a b.png" )'), 'a b.png');
  assert.equal(firstUrl('none'), null);
});

test('comments and BOMs are ignored, unbalanced input does not throw', () => {
  assert.equal(stripCssComments('a{/* } */color:"/*"}'), 'a{color:"/*"}');
  const sheet = tokenizeCss('﻿/* .x{} */ .a{color:red} /* trailing');
  assert.deepEqual(sheet.rules.map((r) => r.selector), ['.a']);
  assert.doesNotThrow(() => tokenizeCss('.a{color:red'));
  assert.doesNotThrow(() => tokenizeCss('}}.a{color:red}'));
  assert.equal(tokenizeCss('}}.a{color:red}').rules.length, 1);
  assert.equal(tokenizeCss('.a{}').rules.length, 1);
});
