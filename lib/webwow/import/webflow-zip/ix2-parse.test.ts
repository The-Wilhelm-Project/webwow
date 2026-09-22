import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { extractIx2Literal, parseIx2FromJs, parseJsObjectLiteral } from './ix2-parse';

test('parses the minified Webflow object-literal subset without eval', () => {
  const src = '{events:{"e-2":{id:"e-2",name:"",flag:!1,on:!0,created:0x17ea5c95c10,dur:1e3,neg:-12.5,nothing:null,undef:void 0,list:[1,2,{a:\'x\'}],esc:"a\\"b\\u0041"}},trailing:{a:1,},}';
  const parsed = parseJsObjectLiteral(src) as Record<string, Record<string, Record<string, unknown>>>;
  const e = parsed.events['e-2'];
  assert.equal(e.id, 'e-2');
  assert.equal(e.flag, false);
  assert.equal(e.on, true);
  assert.equal(e.created, 0x17ea5c95c10);
  assert.equal(e.dur, 1000);
  assert.equal(e.neg, -12.5);
  assert.equal(e.nothing, null);
  assert.equal(e.undef, undefined);
  assert.deepEqual(e.list, [1, 2, { a: 'x' }]);
  assert.equal(e.esc, 'a"bA');
  assert.deepEqual(parsed.trailing, { a: 1 });
});

test('extracts the init argument and ignores strings containing parentheses', () => {
  const js = 'var x=1;Webflow.require("ix2").init({events:{"e-1":{selector:".a )( b",n:!0}},actionLists:{},site:{}});Webflow.require("ix2").init(0);';
  const literal = extractIx2Literal(js);
  assert.ok(literal);
  assert.ok(literal!.startsWith('{events:'));
  assert.ok(literal!.endsWith('site:{}}'));
  const data = parseIx2FromJs(js);
  assert.equal(data?.events['e-1'].selector, '.a )( b');
});

test('returns null when no IX2 block is present', () => {
  assert.equal(parseIx2FromJs('console.log("hi")'), null);
});

test('rejects code that is not a data literal', () => {
  assert.throws(() => parseJsObjectLiteral('{a:function(){return 1}}'));
  assert.throws(() => parseJsObjectLiteral('{a:alert(1)}'));
});

test('parses the sample export when available', { skip: !existsSync(path.join(process.cwd(), 'import/web/valeska-von-brase.webflow/js/valeska-von-brase.js')) }, () => {
  const js = readFileSync(path.join(process.cwd(), 'import/web/valeska-von-brase.webflow/js/valeska-von-brase.js'), 'utf8');
  const data = parseIx2FromJs(js);
  assert.ok(data);
  assert.equal(Object.keys(data!.events).length, 10);
  assert.ok(Object.keys(data!.actionLists).length >= 6);
  assert.equal(data!.site?.mediaQueries?.[0]?.key, 'main');
  const first = Object.values(data!.events)[0];
  assert.equal(typeof first.eventTypeId, 'string');
});
