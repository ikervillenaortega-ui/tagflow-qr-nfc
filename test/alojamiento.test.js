'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAlojamientoInput, resolveLanguage, buildGuestView, LANGUAGES } = require('../src/alojamiento');
const { decryptText } = require('../src/crypto');

const SECRET = 'test-wifi-secret-0123456789';

test('resolveLanguage: Accept-Language con fallback al principal', () => {
  assert.equal(resolveLanguage('en-GB,en;q=0.9,es;q=0.8', 'es'), 'en');
  assert.equal(resolveLanguage('es-ES,es;q=0.9,en;q=0.5', 'es'), 'es');
  assert.equal(resolveLanguage('fr-FR,fr;q=0.9', 'es'), 'es', 'idioma sin traducción → principal');
  assert.equal(resolveLanguage('de-DE,de;q=0.9', 'en'), 'en');
  assert.equal(resolveLanguage('', 'es'), 'es');
  assert.equal(resolveLanguage('pt-BR;q=0.8, en;q=0.9', 'es'), 'en');
});

test('validateAlojamientoInput: WiFi se guarda cifrado y nunca en claro', () => {
  const { errors, blocks } = validateAlojamientoInput({
    aloj_idioma: 'es',
    aloj_wifi_ssid: 'MiRed',
    aloj_wifi_password: 'clave-secreta-123'
  }, { secret: SECRET });
  assert.deepEqual(errors, []);
  assert.equal(blocks.wifi.ssid, 'MiRed');
  assert.ok(blocks.wifi.password_enc);
  assert.ok(!blocks.wifi.password_enc.includes('clave-secreta'), 'la contraseña no está en claro');
  assert.equal(decryptText(blocks.wifi.password_enc, SECRET), 'clave-secreta-123');
});

test('validateAlojamientoInput: bloque WiFi con SSID exige contraseña', () => {
  const { errors } = validateAlojamientoInput({
    aloj_wifi_ssid: 'MiRed',
    aloj_wifi_password: ''
  }, { secret: SECRET });
  assert.ok(errors.some((e) => /contraseña/i.test(e)));
});

test('validateAlojamientoInput: contacto y reseña', () => {
  const ok = validateAlojamientoInput({
    aloj_contacto_whatsapp: '+34 600 123 456',
    aloj_contacto_telefono: '600000000',
    aloj_contacto_email: 'host@ejemplo.com',
    resena_url: 'https://www.airbnb.com/r/mi-piso'
  }, { secret: SECRET });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.blocks.contacto.whatsapp, '+34600123456');
  assert.equal(ok.blocks.contacto.telefono, '600000000');
  assert.equal(ok.blocks.contacto.email, 'host@ejemplo.com');
  assert.equal(ok.blocks.resena.url, 'https://www.airbnb.com/r/mi-piso');

  const bad = validateAlojamientoInput({
    aloj_contacto_whatsapp: '600123456',
    resena_url: 'javascript:alert(1)'
  }, { secret: SECRET });
  assert.ok(bad.errors.length >= 2);
  assert.equal(bad.blocks.resena, undefined);
});

test('validateAlojamientoInput: normas, manual y recomendaciones por líneas', () => {
  const { errors, blocks } = validateAlojamientoInput({
    normas_texto: 'Silencio de 23:00 a 9:00\n\nNo fumar\nMascotas no permitidas',
    manual_texto: 'Aire acondicionado | Mando junto a la puerta | https://youtu.be/abc\nLavadora | Programa 3',
    recomendaciones_texto: 'La Bodega | Restaurante | Tapeo a 2 min\nFarmacia 24h | Farmacia'
  }, { secret: SECRET });
  assert.deepEqual(errors, []);
  assert.equal(blocks.normas.items.length, 3);
  assert.equal(blocks.manual.items[0].title, 'Aire acondicionado');
  assert.equal(blocks.manual.items[0].media_url, 'https://youtu.be/abc');
  assert.equal(blocks.manual.items[1].description, 'Programa 3');
  assert.equal(blocks.recomendaciones.items[0].category, 'Restaurante');
  assert.equal(blocks.recomendaciones.items[1].category, 'Farmacia');
});

test('buildGuestView: elige idioma con fallback y descifra WiFi solo ahí', () => {
  const enc = validateAlojamientoInput(
    { aloj_wifi_ssid: 'RedCasa', aloj_wifi_password: 'pw-huesped-1' },
    { secret: SECRET }
  ).blocks.wifi;

  const rows = [
    { block_type: 'wifi', language: 'es', content: JSON.stringify(enc), is_visible: 1 },
    { block_type: 'acceso', language: 'es', content: JSON.stringify({ texto: 'Código 4521#' }), is_visible: 1 },
    { block_type: 'normas', language: 'en', content: JSON.stringify({ items: [{ text: 'No smoking' }] }), is_visible: 1 }
  ];

  // Huésped inglés: WiFi/acceso salen en español (sin traducción), normas en inglés.
  const enView = buildGuestView({ blockRows: rows, acceptLanguage: 'en-US,en;q=0.9', defaultLanguage: 'es', secret: SECRET });
  assert.equal(enView.lang, 'en');
  const typesEn = enView.blocks.map((b) => b.type);
  assert.deepEqual(typesEn, ['acceso', 'wifi', 'normas']);
  assert.equal(enView.blocks.find((b) => b.type === 'wifi').password, 'pw-huesped-1');
  assert.equal(enView.blocks.find((b) => b.type === 'normas').items[0].text, 'No smoking');

  // Huésped español: normas también en español (fallback al principal → no hay fila es → mejor traducción disponible: en).
  const esView = buildGuestView({ blockRows: rows, acceptLanguage: 'es-ES', defaultLanguage: 'es', secret: SECRET });
  assert.equal(esView.lang, 'es');
  assert.equal(esView.blocks.find((b) => b.type === 'normas').items[0].text, 'No smoking');

  // Vista solo con filas visibles: is_visible = 0 se oculta.
  const hidden = buildGuestView({
    blockRows: [{ block_type: 'acceso', language: 'es', content: JSON.stringify({ texto: 'oculto' }), is_visible: 0 }],
    acceptLanguage: 'es',
    defaultLanguage: 'es',
    secret: SECRET
  });
  assert.equal(hidden.blocks.length, 0);
});

test('buildGuestView: solo bloques rellenados, en orden fijo', () => {
  const rows = [
    { block_type: 'resena', language: 'es', content: JSON.stringify({ url: 'https://g.page/r/x' }), is_visible: 1 },
    { block_type: 'acceso', language: 'es', content: JSON.stringify({ texto: 'Llave en el buzón' }), is_visible: 1 },
    { block_type: 'normas', language: 'es', content: JSON.stringify({ items: [] }), is_visible: 1 }
  ];
  const view = buildGuestView({ blockRows: rows, acceptLanguage: 'es', defaultLanguage: 'es', secret: SECRET });
  // normas vacío no aparece; orden: acceso antes que resena
  assert.deepEqual(view.blocks.map((b) => b.type), ['acceso', 'resena']);
});

test('los idiomas soportados son es y en', () => {
  assert.deepEqual(LANGUAGES, ['es', 'en']);
});
