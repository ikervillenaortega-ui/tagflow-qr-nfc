'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildScanSeries } = require('../src/helpers');

const DAY = 86400000;

function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

test('longitudes de las series: 30 días, 12 semanas, 12 meses, 5 años', () => {
  const s = buildScanSeries([]);
  assert.equal(s.daily.length, 30);
  assert.equal(s.weekly.length, 12);
  assert.equal(s.monthly.length, 12);
  assert.equal(s.yearly.length, 5);
});

test('series vacías quedan a cero', () => {
  const s = buildScanSeries([]);
  assert.ok(s.daily.every((b) => b.count === 0));
  assert.ok(s.monthly.every((b) => b.count === 0));
});

test('los escaneos de hoy caen en el último bucket diario', () => {
  // A pocos segundos de «ahora»: no cruza medianoche UTC nunca.
  const s = buildScanSeries([iso(0), iso(30000), iso(90000)]);
  assert.equal(s.daily[29].count, 3);
  assert.equal(s.daily[28].count, 0);
});

test('el escaneo de ayer cae en su día', () => {
  const s = buildScanSeries([iso(26 * 3600000), iso(27 * 3600000)]);
  assert.equal(s.daily[28].count, 2);
  assert.equal(s.daily[29].count, 0);
});

test('los escaneos de hace 40 días salen en semanal y mensual, no en diaria', () => {
  const s = buildScanSeries([iso(40 * DAY)]);
  assert.equal(s.daily.reduce((a, b) => a + b.count, 0), 0);
  assert.equal(s.weekly.reduce((a, b) => a + b.count, 0), 1);
  assert.ok(s.monthly.reduce((a, b) => a + b.count, 0) >= 1);
});

test('el escaneo de hace 2 años aparece en su año', () => {
  const s = buildScanSeries([iso(2 * 365 * DAY)]);
  assert.equal(s.yearly[2].count, 1);
  assert.equal(s.yearly[4].count, 0);
});

test('marca de tiempo inválida se ignora sin romper', () => {
  const s = buildScanSeries(['no-es-fecha', iso(0)]);
  assert.equal(s.daily[29].count, 1);
});
