import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeDocumentBodyClassName,
  getBodyClasses,
} from '@/lib/body-classes';

import type { Layer } from '@/types';

function layer(partial: Partial<Layer> & Pick<Layer, 'id' | 'name'>): Layer {
  return {
    classes: '',
    children: [],
    ...partial,
  } as Layer;
}

test('reads classes from the body layer by id', () => {
  assert.equal(
    getBodyClasses([
      layer({ id: 'body', name: 'body', classes: 'bg-black text-white' }),
      layer({ id: 'lyr-1', name: 'div', classes: 'p-4' }),
    ]),
    'bg-black text-white',
  );
});

test('reads classes from a body layer identified by name', () => {
  assert.equal(
    getBodyClasses([
      layer({ id: 'lyr-body', name: 'body', classes: ['min-h-screen', 'bg-neutral-950'] }),
    ]),
    'min-h-screen bg-neutral-950',
  );
});

test('returns empty when there is no body layer', () => {
  assert.equal(getBodyClasses([layer({ id: 'lyr-1', name: 'div', classes: 'p-4' })]), '');
  assert.equal(getBodyClasses([]), '');
  assert.equal(getBodyClasses(null), '');
  assert.equal(getBodyClasses(undefined), '');
});

test('composes font-sans with the body layer classes', () => {
  assert.equal(
    composeDocumentBodyClassName('bg-black text-white'),
    'font-sans bg-black text-white',
  );
});

test('falls back to bg-white when the body layer has no classes', () => {
  assert.equal(composeDocumentBodyClassName(''), 'font-sans bg-white');
});
