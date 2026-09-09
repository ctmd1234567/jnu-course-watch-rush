const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCapacity } = require('../src/course-agent');

test('parses available selected/capacity text', () => {
  assert.deepEqual(parseCapacity('94/95 可选', false), {
    selected: 94,
    capacity: 95,
    remaining: 1,
  });
});

test('parses full card where the page hides selected count', () => {
  assert.deepEqual(parseCapacity('95 不可选', true), {
    selected: null,
    capacity: 95,
    remaining: 0,
  });
});

test('keeps unknown capacity explicit', () => {
  assert.deepEqual(parseCapacity('', false), {
    selected: null,
    capacity: null,
    remaining: null,
  });
});
