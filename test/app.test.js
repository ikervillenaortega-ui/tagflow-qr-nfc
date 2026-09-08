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
  sessionTtlMs: 60 * 60 * 1000
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
