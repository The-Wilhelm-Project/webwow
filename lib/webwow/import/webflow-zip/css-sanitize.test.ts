import { test } from 'node:test';
import assert from 'node:assert/strict';
import { neutraliseCss } from './css-sanitize';

test('a </style> breakout inside a string cannot end the style block', () => {
  const { css, changes } = neutraliseCss('.a{content:"</style><script>alert(1)</script>"}');
  assert.ok(!css.includes('<'), css);
  assert.ok(!css.includes('>'), css);
  assert.ok(css.includes('\\3c '), 'angle brackets become CSS hex escapes');
  assert.ok(changes > 0);
});

test('a </STYLE > breakout outside any rule is escaped too', () => {
  const { css } = neutraliseCss('.a{color:red}</STYLE ><script>alert(1)</script>');
  assert.ok(!/<\/?style/i.test(css), css);
  assert.ok(!css.includes('<script'), css);
  assert.ok(css.startsWith('.a{color:red}'));
});

test('child combinators in selectors survive while > inside declarations is escaped', () => {
  const { css } = neutraliseCss('.a > .b{content:">"}');
  assert.ok(css.startsWith('.a > .b{'), css);
  assert.ok(!css.slice(css.indexOf('{')).includes('>'), css);
});

test('@import and @charset statements are removed', () => {
  const { css, changes } = neutraliseCss('@charset "utf-8";@import url(https://evil.example/x.css);.a{color:red}@media (max-width:479px){@import "y.css";.b{color:blue}}');
  assert.ok(!/@import/i.test(css), css);
  assert.ok(!/@charset/i.test(css), css);
  assert.ok(css.includes('.a{color:red}'));
  assert.ok(css.includes('.b{color:blue}'));
  assert.equal(changes, 3);
});

test('expression(), behavior:, -moz-binding and javascript: declarations are dropped', () => {
  const input = '.a{width:expression(alert(1));color:red;behavior:url(x.htc);-moz-binding:url(y.xml#z);background:url(javascript:alert(1))}';
  const { css } = neutraliseCss(input);
  assert.equal(css, '.a{color:red;}');
});

test('url() values must be https, http, image/font data URIs or /storage/ paths', () => {
  const { css } = neutraliseCss([
    '.ok1{background:url(https://cdn.example/x.png)}',
    '.ok2{background:url("http://cdn.example/x.png")}',
    '.ok3{background:url(data:image/png;base64,AAAA)}',
    '.ok4{src:url(data:font/woff2;base64,AAAA)}',
    '.ok5{src:url(data:application/font-woff;base64,AAAA)}',
    '.ok6{background:url(/storage/v1/object/public/assets/website/x.webp)}',
    '.bad1{background:url(data:text/html,<script>alert(1)</script>)}',
    '.bad2{background:url(file:///etc/passwd)}',
    '.bad3{background:url(../images/x.png)}',
    '.bad4{background:url(//cdn.example/x.png)}',
  ].join('\n'));
  for (const ok of ['ok1', 'ok2', 'ok3', 'ok4', 'ok5', 'ok6']) assert.ok(css.includes(`.${ok}{background`) || css.includes(`.${ok}{src`), `${ok} kept: ${css}`);
  for (const bad of ['bad1', 'bad2', 'bad3', 'bad4']) assert.ok(css.includes(`.${bad}{}`), `${bad} dropped: ${css}`);
  assert.ok(!css.includes('<'));
});

test('a clean sheet is returned unchanged (whitespace, media, keyframes, strings included)', () => {
  const clean = [
    '@media (max-width:479px){',
    '  html .wf-a.wf-b:hover .wf-c { color: #fff; background: url(https://x/y.png) no-repeat; }',
    '  html .wf-d::after { content: "a;b"; }',
    '}',
    '@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }',
    '.wf-e { font-family: "Neue Haas", Arial, sans-serif; grid-template-columns: 1fr 1fr; }',
    '',
  ].join('\n');
  const { css, changes } = neutraliseCss(clean);
  assert.equal(changes, 0);
  assert.equal(css, clean);
});

test('neutraliseCss is idempotent', () => {
  const dirty = '.a{content:"</style>";width:expression(1)}@import "x";.b > .c{background:url(javascript:x);color:red}<script>x</script>';
  const first = neutraliseCss(dirty);
  const second = neutraliseCss(first.css);
  assert.equal(second.changes, 0);
  assert.equal(second.css, first.css);
  assert.ok(!first.css.includes('<'));
});

test('empty and degenerate input', () => {
  assert.deepEqual(neutraliseCss(''), { css: '', changes: 0 });
  assert.doesNotThrow(() => neutraliseCss('.a{color:red'));
  assert.doesNotThrow(() => neutraliseCss('}}}'));
  assert.doesNotThrow(() => neutraliseCss('.a{background:url("unterminated}'));
});
