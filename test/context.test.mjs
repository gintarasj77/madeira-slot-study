import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileInventory } from '../lib/context.mjs';

test('PR numbers match by island and preserve multiple booking variants', () => {
  const context = { routes: [{ island: 'Madeira', code: 'PR1' }, { island: 'Porto Santo', code: 'PR1' }, { island: 'Madeira', code: 'PR7' }] };
  const rows = reconcileInventory(context, [{ resourceId: '301', name: 'PR1 | full' }, { resourceId: '225', name: 'PR1 | short' },
    { resourceId: '282', name: 'Porto Santo PR1 | Pico Branco' }]);
  assert.deepEqual(rows[0].bookingResources.map(t => t.resourceId), ['301', '225']);
  assert.deepEqual(rows[1].bookingResources.map(t => t.resourceId), ['282']);
  assert.equal(rows[2].bookingResources.length, 0);
});
