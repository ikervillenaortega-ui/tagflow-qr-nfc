'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const inject = require('light-my-request');
const { openDb } = require('../src/db');
const { createModels } = require('../src/models');
const { createApp } = require('../src/app');

const TEST_CONFIG = {
  root: process.cwd(),
  isProd: false,
  port: 0,
  appName: 'TestFlow',
  baseUrl: '',
  dbPath: ':memory:',
  sessionSecret: 'test-session-secret-0123456789',
  wifiSecret: 'test-wifi-secret-0123456789',
  cookieSecure: false,
  trustProxy: false,
  sessionTtlMs: 60 * 60 * 1000,
  geoEnabled: false
};

let db;
let models;
let app;

before(() => {
  db = openDb(':memory:');
  models = createModels(db, TEST_CONFIG);
  app = createApp({ config: TEST_CONFIG, db });
});

after(() => {
  if (db) db.close();
});

function encodeForm(payload) {
  return Object.entries(payload)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

async function req(path, { method = 'GET', body, headers = {}, cookie } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body) h['content-type'] = 'application/x-www-form-urlencoded';
  return inject(app, {
    method,
    url: path,
    payload: body ? encodeForm(body) : undefined,
    headers: h
  });
}

function getCookie(res) {
  const raw = res.headers['set-cookie'];
  if (!raw) return null;
  const first = Array.isArray(raw) ? raw[0] : String(raw);
  return first.split(';')[0];
}

function getCsrf(html) {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('No se encontró token CSRF en la página');
  return m[1];
}

async function loginAs(username, password) {
  const page = await req('/admin/login');
  const cookie = getCookie(page);
  const res = await req('/admin/login', {
    method: 'POST',
    body: { username, password, _csrf: getCsrf(page.body) },
    cookie
  });
  return { res, cookie: getCookie(res) || cookie };
}

// --- Suite ---

test('la landing pública responde', async () => {
  const res = await req('/');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Un solo QR/);
});

test('healthcheck responde ok', async () => {
  const res = await req('/healthz');
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test('slug inexistente muestra página neutra', async () => {
  const res = await req('/t/no-existe');
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /no está configurado/i);
});

test('login con credenciales incorrectas falla', async () => {
  const { res } = await loginAs('admin', 'wrong-password');
  assert.equal(res.statusCode, 401);
});

test('sin sesión, el panel redirige a login', async () => {
  const res = await req('/admin/tags');
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /\/admin\/login/);
});

test('sin CSRF token, el POST es rechazado', async () => {
  const res = await req('/admin/tags', { method: 'POST', body: { nombre: 'x' } });
  assert.equal(res.statusCode, 403);
});

test('flujo completo: login → crear tag URL → escaneo → editar a WiFi → desactivar → eliminar', async () => {
  models.createUser('admin', bcrypt.hashSync('secret123', 4));

  // 1. Login
  const { res: loginRes, cookie } = await loginAs('admin', 'secret123');
  assert.equal(loginRes.statusCode, 302);
  assert.equal(loginRes.headers.location, '/admin/tags');

  const get = (path) => req(path, { cookie });
  const post = (path, body) => req(path, { method: 'POST', body, cookie });

  // 2. Dashboard accesible
  const dash = await get('/admin/tags');
  assert.equal(dash.statusCode, 200);
  assert.match(dash.body, /Nuevo Tag/);

  // 3. Crear tag en modo URL
  const formPage = await get('/admin/tags/nuevo');
  const csrf = getCsrf(formPage.body);
  const createRes = await post('/admin/tags', {
    _csrf: csrf,
    nombre: 'Mesa 3 · Restaurante',
    tipo: 'ambos',
    modo: 'url',
    url_destino: 'https://ejemplo.com/menu',
    estado: 'activo'
  });
  assert.equal(createRes.statusCode, 302);
  const detailPath = createRes.headers.location;
  assert.match(detailPath, /^\/admin\/tags\/\d+$/);
  const id = Number(detailPath.split('/').pop());

  // 4. Detalle con URL pública y QR descargable
  const detail = await get(detailPath);
  assert.equal(detail.statusCode, 200);
  assert.match(detail.body, /\/t\//);
  const qr = await get(`/admin/tags/${id}/qr.png?payload=url`);
  assert.equal(qr.statusCode, 200);
  assert.equal(qr.headers['content-type'], 'image/png');
  assert.ok(qr.rawPayload.length > 500);
  const qrSvgRes = await get(`/admin/tags/${id}/qr.svg?payload=url`);
  assert.equal(qrSvgRes.statusCode, 200);
  assert.match(qrSvgRes.headers['content-type'], /svg/);

  // 5. Escaneo público: redirige al destino y registra el contador
  const tag = models.getTagById(id);
  const scan = await req(`/t/${tag.slug}`);
  assert.equal(scan.statusCode, 302);
  assert.equal(scan.headers.location, 'https://ejemplo.com/menu');
  assert.equal(models.getTagById(id).escaneos, 1);

  // 6. Editar el tag a modo WiFi (mismo slug, mismo QR físico)
  const editPage = await get(`/admin/tags/${id}/editar`);
  assert.equal(editPage.statusCode, 200);
  const csrf2 = getCsrf(editPage.body);
  const editRes = await post(`/admin/tags/${id}`, {
    _csrf: csrf2,
    nombre: 'Mesa 3 · Restaurante',
    tipo: 'ambos',
    modo: 'wifi',
    wifi_ssid: 'Red Restaurante',
    wifi_password: 'clave-segura-123',
    wifi_seguridad: 'WPA',
    estado: 'activo'
  });
  assert.equal(editRes.statusCode, 302);

  // 7. El mismo slug muestra ahora la página WiFi con instrucciones iOS
  const wifiPage = await req(`/t/${tag.slug}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' }
  });
  assert.equal(wifiPage.statusCode, 200);
  assert.match(wifiPage.body, /Red Restaurante/);
  assert.match(wifiPage.body, /clave-segura-123/);
  // Las instrucciones adaptadas al SO se generan en el cliente (public.js) a
  // partir de data-os; el servidor marca el sistema operativo detectado.
  assert.match(wifiPage.body, /data-os="ios"/);
  assert.equal(models.getTagById(id).escaneos, 2);

  // 8. Editar manteniendo la contraseña (campo en blanco)
  const editPage2 = await get(`/admin/tags/${id}/editar`);
  const csrf3 = getCsrf(editPage2.body);
  const keepPw = await post(`/admin/tags/${id}`, {
    _csrf: csrf3,
    nombre: 'Mesa 3 · Restaurante',
    tipo: 'ambos',
    modo: 'wifi',
    wifi_ssid: 'Red Restaurante',
    wifi_password: '',
    wifi_seguridad: 'WPA',
    estado: 'activo'
  });
  assert.equal(keepPw.statusCode, 302);
  const after = models.getTagById(id);
  assert.equal(models.decryptWifiPassword(after), 'clave-segura-123');

  // 9. Cambiar a desactivado
  const off = await post(`/admin/tags/${id}`, {
    _csrf: csrf3,
    nombre: 'Mesa 3 · Restaurante',
    tipo: 'ambos',
    modo: 'desactivado',
    estado: 'activo'
  });
  assert.equal(off.statusCode, 302);
  const disabled = await req(`/t/${tag.slug}`);
  assert.equal(disabled.statusCode, 200);
  assert.match(disabled.body, /no está configurado/i);

  // 10. Pausar el tag
  const pause = await post(`/admin/tags/${id}/estado`, { _csrf: csrf3 });
  assert.equal(pause.statusCode, 302);
  const paused = await req(`/t/${tag.slug}`);
  assert.match(paused.body, /no está configurado/i);

  // 11. Eliminar
  const del = await post(`/admin/tags/${id}/eliminar`, { _csrf: csrf3 });
  assert.equal(del.statusCode, 302);
  assert.equal(models.getTagById(id), null);
  const gone = await req(`/t/${tag.slug}`);
  assert.equal(gone.statusCode, 404);
});

test('validación rechaza URL inválida y WPA corto', async () => {
  const { cookie } = await loginAs('admin', 'secret123');
  const formPage = await req('/admin/tags/nuevo', { cookie });
  const csrf = getCsrf(formPage.body);

  const bad = await req('/admin/tags', {
    method: 'POST',
    body: { _csrf: csrf, nombre: 'Test', tipo: 'qr', modo: 'url', url_destino: 'ftp://malo.com' },
    cookie
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /http/);

  const badWifi = await req('/admin/tags', {
    method: 'POST',
    body: { _csrf: csrf, nombre: 'Test', tipo: 'qr', modo: 'wifi', wifi_ssid: 'Red', wifi_password: 'corto', wifi_seguridad: 'WPA' },
    cookie
  });
  assert.equal(badWifi.statusCode, 400);
  assert.match(badWifi.body, /entre 8 y 63/);
});

test('modo Contacto: creación, página pública con tel/email y payload vCard', async () => {
  const { cookie } = await loginAs('admin', 'secret123');
  const get = (path) => req(path, { cookie });
  const post = (path, body) => req(path, { method: 'POST', body, cookie });

  // 1. Crear tag en modo Contacto (teléfono + correo)
  const formPage = await get('/admin/tags/nuevo');
  const csrf = getCsrf(formPage.body);
  const createRes = await post('/admin/tags', {
    _csrf: csrf,
    nombre: 'Atención al cliente',
    tipo: 'ambos',
    modo: 'contacto',
    contacto_telefono: '+34 600 123 456',
    contacto_email: 'hola@ejemplo.com',
    estado: 'activo'
  });
  assert.equal(createRes.statusCode, 302);
  const id = Number(createRes.headers.location.split('/').pop());
  const tag = models.getTagById(id);
  assert.equal(tag.modo, 'contacto');
  assert.equal(tag.contactoTelefono, '+34 600 123 456');
  assert.equal(tag.contactoEmail, 'hola@ejemplo.com');

  // 2. Página pública: teléfono con enlace tel: y correo con mailto:
  const pub = await req(`/t/${tag.slug}`);
  assert.equal(pub.statusCode, 200);
  assert.match(pub.body, /\+34 600 123 456/);
  assert.match(pub.body, /hola@ejemplo\.com/);
  assert.match(pub.body, /href="tel:/);
  assert.match(pub.body, /href="mailto:/);
  assert.match(pub.body, /data-copy-val/);

  // 3. Detalle: muestra los datos y el payload vCard para NFC
  const detail = await get(`/admin/tags/${id}`);
  assert.equal(detail.statusCode, 200);
  assert.match(detail.body, /BEGIN:VCARD/);
  assert.match(detail.body, /FN:Atención al cliente/);
  assert.match(detail.body, /TEL;TYPE=CELL:\+34600123456/);
  assert.match(detail.body, /EMAIL:hola@ejemplo\.com/);

  // 4. QR de contacto (vCard) descargable
  const qr = await get(`/admin/tags/${id}/qr.png?payload=contacto`);
  assert.equal(qr.statusCode, 200);
  assert.equal(qr.headers['content-type'], 'image/png');
  assert.ok(qr.rawPayload.length > 500);

  // 5. Validación: sin datos de contacto → 400
  const badEmpty = await post('/admin/tags', {
    _csrf: csrf,
    nombre: 'Vacío',
    tipo: 'qr',
    modo: 'contacto',
    estado: 'activo'
  });
  assert.equal(badEmpty.statusCode, 400);
  assert.match(badEmpty.body, /al menos un teléfono o un correo/);

  // 6. Validación: correo inválido → 400
  const badEmail = await post('/admin/tags', {
    _csrf: csrf,
    nombre: 'Correo malo',
    tipo: 'qr',
    modo: 'contacto',
    contacto_email: 'no-es-un-correo',
    estado: 'activo'
  });
  assert.equal(badEmail.statusCode, 400);
  assert.match(badEmail.body, /no parece válido/);

  // 7. Solo teléfono es suficiente
  const onlyTel = await post('/admin/tags', {
    _csrf: csrf,
    nombre: 'Solo teléfono',
    tipo: 'nfc',
    modo: 'contacto',
    contacto_telefono: '600000000',
    estado: 'activo'
  });
  assert.equal(onlyTel.statusCode, 302);
});

test('logout cierra la sesión', async () => {
  const { cookie } = await loginAs('admin', 'secret123');
  const formPage = await req('/admin/tags', { cookie });
  const csrf = getCsrf(formPage.body);
  const out = await req('/admin/logout', { method: 'POST', body: { _csrf: csrf }, cookie });
  assert.equal(out.statusCode, 302);
  const after = await req('/admin/tags', { cookie: getCookie(out) || cookie });
  assert.equal(after.statusCode, 302);
  assert.match(after.headers.location, /\/admin\/login/);
});

test('creación masiva: formulario, validación y creación correlativa', async () => {
  const { cookie } = await loginAs('admin', 'secret123');

  // 1. Formulario accesible
  const formPage = await req('/admin/tags/masivo', { cookie });
  assert.equal(formPage.statusCode, 200);
  assert.match(formPage.body, /Generar Tags en lote/);
  const csrf = getCsrf(formPage.body);

  // 2. Cantidad fuera de rango → 400
  const bad = await req('/admin/tags/masivo', {
    method: 'POST',
    body: { _csrf: csrf, cantidad: '0', prefijo: 'Stock' },
    cookie
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /entre 1 y 500/);

  // 3. Crear 3 tags de stock
  const ok = await req('/admin/tags/masivo', {
    method: 'POST',
    body: { _csrf: csrf, cantidad: '3', prefijo: 'Stock', tipo: 'ambos' },
    cookie
  });
  assert.equal(ok.statusCode, 302);
  assert.match(ok.headers.location, /modo=desactivado/);

  const stock = models.listTagsByModo('desactivado');
  assert.equal(stock.length, 3);
  const nombres = stock.map((t) => t.nombre);
  assert.deepEqual(nombres, ['Stock 1', 'Stock 2', 'Stock 3']);
  for (const t of stock) {
    assert.equal(t.modo, 'desactivado');
    assert.equal(t.tipo, 'ambos');
    assert.equal(t.estado, 'activo');
    assert.match(t.slug, /^[A-Za-z0-9]{8}$/);
  }

  // 4. La numeración continúa donde quedó
  const ok2 = await req('/admin/tags/masivo', {
    method: 'POST',
    body: { _csrf: csrf, cantidad: '2', prefijo: 'Stock', tipo: 'qr' },
    cookie
  });
  assert.equal(ok2.statusCode, 302);
  const stock2 = models.listTagsByModo('desactivado');
  assert.equal(stock2.length, 5);
  assert.equal(stock2[3].nombre, 'Stock 4');
  assert.equal(stock2[4].nombre, 'Stock 5');
  assert.equal(stock2[4].tipo, 'qr');
});

test('descarga ZIP de QR pendientes', async () => {
  const { cookie } = await loginAs('admin', 'secret123');
  const pendientes = models.listTagsByModo('desactivado');
  assert.ok(pendientes.length >= 2, 'debe haber tags pendientes de la prueba anterior');

  const zip = await req('/admin/tags/qr-pendientes.zip', { cookie });
  assert.equal(zip.statusCode, 200);
  assert.match(zip.headers['content-type'], /application\/zip/);
  assert.match(zip.headers['content-disposition'], /qr-pendientes\.zip/);
  // Cabecera de fichero ZIP (PK\x03\x04) y nombres de fichero en claro.
  assert.ok(zip.rawPayload.subarray(0, 2).toString() === 'PK');
  assert.ok(zip.rawPayload.includes('.png'), 'el ZIP contiene ficheros PNG');
  assert.ok(zip.rawPayload.includes(pendientes[0].slug), 'el ZIP nombra los ficheros con el slug');
  assert.ok(zip.rawPayload.length > 500);
});

test('la ruta ZIP exige sesión', async () => {
  const anon = await req('/admin/tags/qr-pendientes.zip');
  assert.equal(anon.statusCode, 302);
  assert.match(anon.headers.location, /\/admin\/login/);
});

test('el escaneo guarda ubicación y el detalle la muestra', async () => {
  const tag = models.createTag({
    nombre: 'Ubicación Test',
    tipo: 'ambos',
    modo: 'desactivado',
    estado: 'activo'
  });

  // 1. Un escaneo real crea la fila en scans y devuelve su id.
  const scanId = models.recordScan(tag.id, { ip: '::ffff:127.0.0.1', headers: { 'user-agent': 'curl/8' } });
  assert.ok(scanId > 0);

  // 2. Simula la geolocalización resuelta por IP (la red está desactivada en tests).
  models.updateScanLocation(scanId, {
    city: 'Madrid',
    region: 'Comunidad de Madrid',
    country: 'España',
    lat: 40.4168,
    lon: -3.7038
  });
  // 2b. Un escaneo sin ubicación guarda la nota con el motivo.
  const scanId2 = models.recordScan(tag.id, { ip: '127.0.0.1', headers: { 'user-agent': 'curl/8' } });
  models.updateScanLocation(scanId2, null, 'IP privada o local: imposible geolocalizar');
  const scans = models.recentScans(tag.id, 5);
  assert.equal(scans[1].city, 'Madrid');
  assert.equal(scans[1].country, 'España');
  assert.equal(scans[0].geo_note, 'IP privada o local: imposible geolocalizar');

  // 3. El detalle del tag muestra la ubicación, el enlace al mapa y la nota del escaneo sin ubicación.
  const { cookie } = await loginAs('admin', 'secret123');
  const detail = await req(`/admin/tags/${tag.id}`, { cookie });
  assert.equal(detail.statusCode, 200);
  assert.match(detail.body, /Madrid, Comunidad de Madrid, España/);
  assert.match(detail.body, /Ver en el mapa/);
  assert.match(detail.body, /google\.com\/maps/);
  assert.match(detail.body, /IP privada o local: imposible geolocalizar/);
});
