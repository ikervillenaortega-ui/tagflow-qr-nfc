'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildWifiString } = require('../src/wifi');

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