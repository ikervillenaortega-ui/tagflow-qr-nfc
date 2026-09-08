'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encryptText, decryptText } = require('../src/crypto');

test('cifra y descifra correctamente', () => {
  const secret = 'clave-maestra-de-prueba';
  const enc = encryptText('contraseña-wifi-123', secret);
  assert.notEqual(enc, 'contraseña-wifi-123');
  assert.ok(enc.startsWith('v1.'));
  assert.equal(decryptText(enc, secret), 'contraseña-wifi-123');
});

test('produce cifrados distintos para el mismo texto (IV aleatorio)', () => {
  const secret = 'clave-maestra-de-prueba';
  const a = encryptText('hola', secret);
  const b = encryptText('hola', secret);
  assert.notEqual(a, b);
});

test('detecta manipulación del payload', () => {
  const secret = 'clave-maestra-de-prueba';
  const enc = encryptText('hola', secret);
  const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => decryptText(tampered, secret));
});

test('falla con una clave distinta', () => {
  const enc = encryptText('hola', 'clave-a-0123456789');
  assert.throws(() => decryptText(enc, 'clave-b-0123456789'));
});