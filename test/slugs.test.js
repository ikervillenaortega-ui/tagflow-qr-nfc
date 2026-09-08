'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateSlug, isValidSlug } = require('../src/slugs');

test('genera slugs únicos y con el formato correcto', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const s = generateSlug();
    assert.match(s, /^[A-Za-z0-9_-]{8}$/);
    assert.ok(!seen.has(s), `slug duplicado: ${s}`);
    seen.add(s);
  }
});

test('valida slugs correctos e incorrectos', () => {
  assert.ok(isValidSlug('mesa-3'));
  assert.ok(isValidSlug('a_b'));
  assert.ok(isValidSlug('ABC'));
  assert.ok(!isValidSlug('ab'));
  assert.ok(!isValidSlug('con espacios'));
  assert.ok(!isValidSlug(''));
  assert.ok(!isValidSlug('a'.repeat(65)));
  assert.ok(!isValidSlug(null));
});