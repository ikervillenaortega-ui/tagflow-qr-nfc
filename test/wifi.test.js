'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildWifiString, buildAndroidWifiCredential } = require('../src/wifi');

test('genera el string estándar WPA', () => {
  const out = buildWifiString({ ssid: 'MiRed', password: 'clave1234', security: 'WPA' });
  assert.equal(out, 'WIFI:T:WPA;S:MiRed;P:clave1234;;');
});

test('genera el string para red abierta', () => {
  const out = buildWifiString({ ssid: 'Café', security: 'nopass' });
  assert.equal(out, 'WIFI:T:nopass;S:Café;;');
});

test('genera WEP', () => {
  const out = buildWifiString({ ssid: 'X', password: '12345', security: 'WEP' });
  assert.equal(out, 'WIFI:T:WEP;S:X;P:12345;;');
});

test('escapa caracteres especiales del formato', () => {
  const out = buildWifiString({ ssid: 'Red;Oficina', password: 'a:b"c\\d,e', security: 'WPA' });
  assert.equal(out, 'WIFI:T:WPA;S:Red\\;Oficina;P:a\\:b\\"c\\\\d\\,e;;');
});

test('usa WPA por defecto si la seguridad es desconocida', () => {
  const out = buildWifiString({ ssid: 'Red', password: 'clave1234', security: 'RARO' });
  assert.equal(out, 'WIFI:T:WPA;S:Red;P:clave1234;;');
});

test('credencial Android WPA incluye ssid y contraseña', () => {
  const cred = buildAndroidWifiCredential({ ssid: 'MiRed', password: 'clave1234', security: 'WPA' });
  assert.deepEqual(cred, { type: 'wpa2', ssid: 'MiRed', password: 'clave1234' });
});

test('credencial Android para red abierta sin contraseña', () => {
  const cred = buildAndroidWifiCredential({ ssid: 'Café', security: 'nopass' });
  assert.deepEqual(cred, { type: 'open', ssid: 'Café' });
  assert.ok(!('password' in cred));
});

test('credencial Android WEP mapea el tipo', () => {
  const cred = buildAndroidWifiCredential({ ssid: 'X', password: '12345', security: 'WEP' });
  assert.deepEqual(cred, { type: 'wep', ssid: 'X', password: '12345' });
});

test('credencial Android con seguridad desconocida usa wpa2', () => {
  const cred = buildAndroidWifiCredential({ ssid: 'Red', password: 'clave1234', security: 'RARO' });
  assert.equal(cred.type, 'wpa2');
});