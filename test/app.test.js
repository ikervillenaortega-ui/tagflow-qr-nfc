'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const inject = require('light-my-request');
const { openDb } = require('../src/db');
const { createModels } = require('../src/models');
const { createApp } = require('../src/app');
const { normalizeNfcUid } = require('../src/routes/admin');

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

// Petición con cuerpo en crudo (p. ej. subida del fichero de copia).
async function rawReq(path, { buffer, headers = {}, cookie } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  return inject(app, { method: 'POST', url: path, payload: buffer, headers: h });
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

test('login con token caducado muestra el formulario con mensaje claro y token nuevo', async () => {
  const res = await req('/admin/login', { method: 'POST', body: { username: 'Iker', password: 'Iker2009', _csrf: 'token-viejo' } });
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /caducado/);
  // Y trae un token fresco para que el reintento funcione sin recargar.
  assert.match(res.body, /name="_csrf" value="[0-9a-f]{64}"/);
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
  // Botón de conexión directa y credencial para Android (Chrome): al pulsar,
  // el sistema abre su diálogo nativo para unirse a la red.
  assert.match(wifiPage.body, /Conectar a la red/);
  assert.match(wifiPage.body, /data-cred='/);
  assert.match(wifiPage.body, /type&#34;:&#34;wpa2&#34;/);
  assert.match(wifiPage.body, /Red Restaurante/);
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

test('flujo de venta: tag genérico → «Configurar (venta)» → modo Contacto con datos del comprador', async () => {
  const { cookie } = await loginAs('admin', 'secret123');
  const get = (path) => req(path, { cookie });
  const post = (path, body) => req(path, { method: 'POST', body, cookie });

  // 1. Generar stock genérico (desactivado)
  const bulkPage = await get('/admin/tags/masivo');
  const csrfBulk = getCsrf(bulkPage.body);
  await post('/admin/tags/masivo', { _csrf: csrfBulk, cantidad: '1', prefijo: 'Venta', tipo: 'ambos' });
  const stock = models.listTagsByModo('desactivado');
  assert.equal(stock.length, 1);

  // 2. El dashboard ofrece «Configurar (venta)» para los tags sin configurar
  const dash = await get('/admin/tags');
  assert.equal(dash.statusCode, 200);
  assert.match(dash.body, /Configurar \(venta\)/);
  assert.ok(dash.body.includes(`/admin/tags/${stock[0].id}/editar?modo=contacto`));

  // 3. El enlace abre el formulario con el modo Contacto preseleccionado
  const editPage = await get(`/admin/tags/${stock[0].id}/editar?modo=contacto`);
  assert.equal(editPage.statusCode, 200);
  assert.match(editPage.body, /value="contacto" checked/);
  assert.match(editPage.body, /Datos de contacto/);

  // 4. Guardar teléfono y correo del comprador → el mismo QR pasa a modo Contacto
  const csrfEdit = getCsrf(editPage.body);
  const saveRes = await post(`/admin/tags/${stock[0].id}`, {
    _csrf: csrfEdit,
    nombre: 'Cliente María',
    tipo: 'ambos',
    modo: 'contacto',
    contacto_telefono: '+34 611 222 333',
    contacto_email: 'maria@correo.com',
    estado: 'activo'
  });
  assert.equal(saveRes.statusCode, 302);
  const vendido = models.getTagById(stock[0].id);
  assert.equal(vendido.modo, 'contacto');
  assert.equal(vendido.contactoTelefono, '+34 611 222 333');
  assert.equal(vendido.contactoEmail, 'maria@correo.com');
  assert.equal(vendido.nombre, 'Cliente María');

  // 5. El QR físico no cambia: el slug es el mismo y la página pública ya muestra el contacto
  const pub = await req(`/t/${vendido.slug}`);
  assert.equal(pub.statusCode, 200);
  assert.match(pub.body, /\+34 611 222 333/);
  assert.match(pub.body, /href="tel:/);

  // 6. El dashboard ya no ofrece «Configurar (venta)» para el tag configurado
  const dash2 = await get('/admin/tags');
  assert.ok(!dash2.body.includes(`/admin/tags/${stock[0].id}/editar?modo=contacto`));
});

test('copia de seguridad: descarga un .db válido y la restauración sustituye los datos', async () => {
  const { cookie } = await loginAs('admin', 'secret123');
  const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  const base = { tags: count('tags'), scans: count('scans') };

  // 1. Estado conocido: dos tags nuevos, uno con un escaneo (relativo a lo que había).
  const a = models.createTag({
    nombre: 'Backup A',
    tipo: 'qr',
    modo: 'url',
    urlDestino: 'https://a.example.com',
    estado: 'activo'
  });
  const b = models.createTag({ nombre: 'Backup B', tipo: 'nfc', modo: 'desactivado', estado: 'activo' });
  models.recordScan(a.id, { ip: '127.0.0.1', headers: { 'user-agent': 'curl/8' } });
  const antes = { tags: base.tags + 2, scans: base.scans + 1 };

  // 2. La página de copia muestra el estado y el enlace de descarga.
  const page = await req('/admin/backup', { cookie });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Descargar copia de seguridad/);
  assert.match(page.body, /Restaurar una copia/);
  const csrf = getCsrf(page.body);

  // 3. Descargar genera un fichero SQLite real (cabecera mágica + contenido).
  const dl = await req('/admin/backup/descargar', { cookie });
  assert.equal(dl.statusCode, 200);
  assert.match(dl.headers['content-disposition'], /tagflow-backup-.*\.db/);
  const magic = Buffer.from('SQLite format 3\u0000');
  assert.ok(dl.rawPayload.subarray(0, 16).equals(magic), 'el fichero es SQLite');
  assert.ok(dl.rawPayload.length > 2000);

  // 4. Se altera la base de datos actual (tag extra y borrado del primero).
  const extra = models.createTag({ nombre: 'Extra', tipo: 'qr', modo: 'desactivado', estado: 'activo' });
  models.deleteTag(a.id);
  assert.equal(count('tags'), antes.tags); // b + Extra

  // 5. Restaurar la copia devuelve los datos de la copia: Extra desaparece, Backup A vuelve.
  const up = await rawReq('/admin/backup/restaurar', {
    cookie,
    buffer: Buffer.from(dl.rawPayload),
    headers: { 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' }
  });
  assert.equal(up.statusCode, 200);
  const json = JSON.parse(up.body);
  assert.equal(json.ok, true);
  // La copia contenía a y b: tras restaurar vuelven ellos y desaparece Extra.
  assert.equal(count('tags'), antes.tags, 'los tags de la copia sustituyen a los actuales');
  assert.equal(count('scans'), antes.scans, 'los escaneos de la copia sustituyen a los actuales');
  assert.ok(models.getTagById(a.id), 'el tag borrado antes de restaurar vuelve a existir');
  assert.equal(models.getTagById(a.id).urlDestino, 'https://a.example.com');
  assert.equal(models.getTagById(b.id).modo, 'desactivado');
  assert.equal(models.getTagById(extra.id), null, 'el tag creado después de la copia desaparece');

  // Limpieza: se eliminan los tags propios para no afectar a los demás tests.
  models.deleteTag(a.id);
  models.deleteTag(b.id);
  assert.equal(count('tags'), base.tags);
});

test('copia de seguridad: un fichero que no es SQLite se rechaza', async () => {
  const { cookie } = await loginAs('admin', 'secret123');
  const page = await req('/admin/backup', { cookie });
  const csrf = getCsrf(page.body);
  const up = await rawReq('/admin/backup/restaurar', {
    cookie,
    buffer: Buffer.from('esto no es una base de datos sqlite'.repeat(20)),
    headers: { 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' }
  });
  assert.equal(up.statusCode, 400);
  const json = JSON.parse(up.body);
  assert.equal(json.ok, false);
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

test('gráfica de escaneos: series en el detalle y endpoint JSON', async () => {
  const { cookie } = await loginAs('admin', 'secret123');

  // Tag nuevo con 3 escaneos de fechas variadas (hoy, hace 3 días, hace 40 días)
  const formPage = await req('/admin/tags/nuevo', { cookie });
  const csrf = getCsrf(formPage.body);
  const created = await req('/admin/tags', {
    method: 'POST',
    body: { _csrf: csrf, nombre: 'Con Grafica', tipo: 'qr', modo: 'url', url_destino: 'https://ejemplo.com/grafica', estado: 'activo' },
    cookie
  });
  assert.equal(created.statusCode, 302);
  const tagRow = db.prepare('SELECT id FROM tags WHERE nombre = ?').get('Con Grafica');
  assert.ok(tagRow, 'el tag de la gráfica se creó');
  const tag = models.getTagById(tagRow.id);

  const DAY = 86400000;
  const insScan = db.prepare('INSERT INTO scans (tag_id, created_at, user_agent, ip_hash, referrer) VALUES (?, ?, ?, ?, ?)');
  insScan.run(tag.id, new Date().toISOString(), 'UA test', 'h1', null);
  insScan.run(tag.id, new Date(Date.now() - 3 * DAY).toISOString(), 'UA test', 'h2', 'https://instagram.com/p/abc');
  insScan.run(tag.id, new Date(Date.now() - 40 * DAY).toISOString(), 'UA test', 'h3', null);
  // El contador del tag no sube con inserts directos: lo dejo coherente.
  db.prepare('UPDATE tags SET escaneos = 3 WHERE id = ?').run(tag.id);

  // El detalle muestra el panel de la gráfica con las series embebidas
  const page = await req(`/admin/tags/${tag.id}`, { cookie });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Gráfica de escaneos/);
  assert.match(page.body, /chart-panel/);
  assert.match(page.body, /Origen de los escaneos/);
  assert.match(page.body, /data-series='\{&#34;daily&#34;:\[\{&#34;label&#34;:&#34;\d\d\/\d\d&#34;/);

  // El endpoint JSON devuelve las series y la procedencia
  const jsonRes = await req(`/admin/tags/${tag.id}/scans.json`, { cookie });
  assert.equal(jsonRes.statusCode, 200);
  const data = JSON.parse(jsonRes.body);
  assert.equal(data.series.daily.length, 30);
  assert.equal(data.series.weekly.length, 12);
  assert.equal(data.series.monthly.length, 12);
  assert.equal(data.series.yearly.length, 5);
  assert.equal(data.series.daily[29].count, 1);
  assert.equal(data.series.daily[26].count, 1);
  assert.equal(data.series.monthly.reduce((a, b) => a + b.count, 0), 3);
  assert.equal(data.series.yearly.reduce((a, b) => a + b.count, 0), 3);
  assert.equal(data.origen.directo, 2);
  assert.equal(data.origen.web, 1);
  assert.ok(data.origen.sites.some((s) => s.host === 'instagram.com'));
  assert.equal(data.total, 3);

  // Limpieza para no afectar a tests posteriores
  models.deleteTag(tag.id);
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

test('modo Presentación: tarjeta con foto circular, descripción y contacto al final', async () => {
  const { cookie } = await loginAs('admin', 'secret123');
  const get = (path) => req(path, { cookie });
  const post = (path, body) => req(path, { method: 'POST', body, cookie });

  // Data URL válida (formato JPEG en base64; el contenido no necesita ser una imagen real para la suite).
  const foto = `data:image/jpeg;base64,${'A'.repeat(200)}`;

  // 1. Crear tag en modo Presentación con foto, cargo, descripción y contacto
  const formPage = await get('/admin/tags/nuevo');
  const csrf = getCsrf(formPage.body);
  const createRes = await post('/admin/tags', {
    _csrf: csrf,
    nombre: 'Tarjeta María',
    tipo: 'ambos',
    modo: 'presentacion',
    pres_persona_nombre: 'María García',
    pres_cargo: 'Directora Comercial',
    pres_bio: 'Ayudo a las empresas a crecer con estrategias digitales.',
    contacto_telefono: '+34 622 333 444',
    contacto_email: 'maria@empresa.com',
    pres_foto_data: foto,
    estado: 'activo'
  });
  assert.equal(createRes.statusCode, 302);
  const id = Number(createRes.headers.location.split('/').pop());
  const tag = models.getTagById(id);
  assert.equal(tag.modo, 'presentacion');
  assert.equal(tag.presPersonaNombre, 'María García');
  assert.equal(tag.presCargo, 'Directora Comercial');
  assert.equal(tag.presBio, 'Ayudo a las empresas a crecer con estrategias digitales.');
  assert.equal(tag.presFoto, foto);
  assert.equal(tag.contactoTelefono, '+34 622 333 444');

  // 2. Página pública: foto circular, nombre, cargo, descripción y contacto al final
  const pub = await req(`/t/${tag.slug}`);
  assert.equal(pub.statusCode, 200);
  assert.match(pub.body, /María García/);
  assert.match(pub.body, /Directora Comercial/);
  assert.match(pub.body, /estrategias digitales/);
  assert.match(pub.body, /src="data:image\/jpeg;base64,/);
  assert.match(pub.body, /href="tel:/);
  assert.match(pub.body, /href="mailto:/);
  assert.match(pub.body, /Guardar en contactos/);

  // 3. vCard pública con nombre, cargo y descripción
  const vcf = await req(`/t/${tag.slug}/contacto.vcf`);
  assert.equal(vcf.statusCode, 200);
  assert.match(vcf.headers['content-type'], /text\/vcard/);
  assert.match(vcf.body, /BEGIN:VCARD/);
  assert.match(vcf.body, /FN:María García/);
  assert.match(vcf.body, /TITLE:Directora Comercial/);
  assert.match(vcf.body, /TEL;TYPE=CELL:\+34622333444/);
  assert.match(vcf.body, /EMAIL:maria@empresa\.com/);
  assert.match(vcf.body, /NOTE:ayudo a las empresas/i);

  // 4. Detalle del panel: resumen de la presentación y descarga circular
  const detail = await get(`/admin/tags/${id}`);
  assert.equal(detail.statusCode, 200);
  assert.match(detail.body, /Presentación personal/);
  assert.match(detail.body, /María García/);
  assert.match(detail.body, /foto\.png/);

  // 5. QR de presentación (vCard) descargable en PNG y SVG
  const qr = await get(`/admin/tags/${id}/qr.png?payload=contacto`);
  assert.equal(qr.statusCode, 200);
  assert.equal(qr.headers['content-type'], 'image/png');
  const qrSvg = await get(`/admin/tags/${id}/qr.svg?payload=contacto`);
  assert.equal(qrSvg.statusCode, 200);
  assert.match(qrSvg.headers['content-type'], /svg/);

  // 6. Descarga de la foto circular (SVG con clip)
  const fotoDl = await get(`/admin/tags/${id}/foto.png`);
  assert.equal(fotoDl.statusCode, 200);
  assert.match(fotoDl.headers['content-type'], /svg/);
  assert.match(fotoDl.body, /clipPath/);
  assert.match(fotoDl.body, /circle/);

  // 7. Editar sin tocar la foto la conserva
  const editPage = await get(`/admin/tags/${id}/editar`);
  const csrf2 = getCsrf(editPage.body);
  const keepRes = await post(`/admin/tags/${id}`, {
    _csrf: csrf2,
    nombre: 'Tarjeta María',
    tipo: 'ambos',
    modo: 'presentacion',
    pres_persona_nombre: 'María García López',
    pres_cargo: 'Directora Comercial',
    pres_bio: 'Nueva descripción.',
    contacto_telefono: '+34 622 333 444',
    contacto_email: 'maria@empresa.com',
    estado: 'activo'
  });
  assert.equal(keepRes.statusCode, 302);
  assert.equal(models.getTagById(id).presFoto, foto, 'la foto se conserva al editar sin tocarla');

  // 8. «Quitar foto» la limpia
  const rmRes = await post(`/admin/tags/${id}`, {
    _csrf: csrf2,
    nombre: 'Tarjeta María',
    tipo: 'ambos',
    modo: 'presentacion',
    pres_persona_nombre: 'María García López',
    pres_cargo: '',
    pres_bio: '',
    contacto_telefono: '+34 622 333 444',
    contacto_email: 'maria@empresa.com',
    pres_foto_clear: '1',
    estado: 'activo'
  });
  assert.equal(rmRes.statusCode, 302);
  assert.equal(models.getTagById(id).presFoto, null);

  // 9. Validación: sin nombre de persona → 400; foto con formato inválido → 400
  const badName = await post('/admin/tags', {
    _csrf: csrf, nombre: 'Sin nombre', tipo: 'qr', modo: 'presentacion', estado: 'activo'
  });
  assert.equal(badName.statusCode, 400);
  assert.match(badName.body, /nombre de la persona es obligatorio/);

  const badFoto = await post('/admin/tags', {
    _csrf: csrf, nombre: 'Foto mala', tipo: 'qr', modo: 'presentacion',
    pres_persona_nombre: 'Alguien', pres_foto_data: 'data:image/gif;base64,AAAA', estado: 'activo'
  });
  assert.equal(badFoto.statusCode, 400);
  assert.match(badFoto.body, /JPG o PNG/);

  // Limpieza
  models.deleteTag(id);
});

test('flujo de venta con Presentación: stock → configurar → tarjeta del comprador', async () => {
  const { cookie } = await loginAs('admin', 'secret123');
  const get = (path) => req(path, { cookie });
  const post = (path, body) => req(path, { method: 'POST', body, cookie });

  // 1. Stock genérico pendiente
  const stock = models.listTagsByModo('desactivado');
  assert.ok(stock.length >= 1);
  const target = stock[0];

  // 2. El enlace «Presentación» preselecciona el modo en el formulario
  const editPage = await get(`/admin/tags/${target.id}/editar?modo=presentacion`);
  assert.equal(editPage.statusCode, 200);
  assert.match(editPage.body, /value="presentacion" checked/);
  assert.match(editPage.body, /Presentación personal/);

  // 3. Configurar con los datos del comprador → la misma URL sirve la tarjeta
  const csrf = getCsrf(editPage.body);
  const saveRes = await post(`/admin/tags/${target.id}`, {
    _csrf: csrf,
    nombre: 'Cliente Presentación',
    tipo: 'ambos',
    modo: 'presentacion',
    pres_persona_nombre: 'Luis Pérez',
    pres_cargo: 'Consultor',
    pres_bio: 'Tarjeta de ejemplo.',
    contacto_telefono: '600111222',
    estado: 'activo'
  });
  assert.equal(saveRes.statusCode, 302);
  const vendido = models.getTagById(target.id);
  assert.equal(vendido.modo, 'presentacion');
  assert.equal(vendido.presPersonaNombre, 'Luis Pérez');

  const pub = await req(`/t/${vendido.slug}`);
  assert.equal(pub.statusCode, 200);
  assert.match(pub.body, /Luis Pérez/);
  // Sin foto: se muestran las iniciales como avatar
  assert.match(pub.body, /initials|LP/, 'avatar con iniciales cuando no hay foto');

  // Limpieza: devolver el tag a desactivado para otros tests
  models.updateTag(target.id, { modo: 'desactivado' });
});

test('módulo Alojamiento: bloques multi-idioma, WiFi cifrado, despedida y duplicado', async () => {
  const { cookie } = await loginAs('admin', 'secret123');
  const get = (path) => req(path, { cookie });
  const post = (path, body) => req(path, { method: 'POST', body, cookie });

  // 1. Crear propiedad en modo Alojamiento con contenido en español e inglés
  const formPage = await get('/admin/tags/nuevo?modo=alojamiento');
  assert.equal(formPage.statusCode, 200);
  assert.match(formPage.body, /Alojamiento turístico/);
  const csrf = getCsrf(formPage.body);
  const createRes = await post('/admin/tags', {
    _csrf: csrf,
    nombre: 'Apartamento Centro 2B',
    tipo: 'nfc',
    modo: 'alojamiento',
    estado: 'activo',
    aloj_idioma: 'es',
    // Español
    b_es_present: '1',
    b_es_acceso_texto: 'Código puerta 4521#. Llave en el cajón del recibidor.',
    b_es_aloj_wifi_ssid: 'Casa2B',
    b_es_aloj_wifi_password: 'wifi-seguro-99',
    b_es_normas_texto: 'Silencio de 23:00 a 9:00\nNo fumar',
    b_es_manual_texto: 'Aire acondicionado | Mando junto a la puerta',
    b_es_recomendaciones_texto: 'La Bodega | Restaurante | Tapeo a 2 min',
    b_es_aloj_contacto_whatsapp: '+34600123456',
    b_es_resena_url: 'https://g.page/r/resena-es',
    // Inglés (solo acceso y reseña traducidos)
    b_en_present: '1',
    b_en_acceso_texto: 'Door code 4521#. Key in the hall drawer.',
    b_en_resena_url: 'https://g.page/r/review-en'
  });
  assert.equal(createRes.statusCode, 302);
  const id = Number(createRes.headers.location.split('/').pop());
  const tag = models.getTagById(id);
  assert.equal(tag.modo, 'alojamiento');
  assert.equal(tag.alojIdioma, 'es');

  // 2. Los bloques quedaron guardados: WiFi cifrado (nunca en claro en BD)
  const blockRows = models.listBlocks(id);
  assert.ok(blockRows.length >= 7, `bloques guardados: ${blockRows.length}`);
  const wifiRow = blockRows.find((r) => r.block_type === 'wifi' && r.language === 'es');
  assert.ok(wifiRow);
  const wifiContent = JSON.parse(wifiRow.content);
  assert.equal(wifiContent.ssid, 'Casa2B');
  assert.ok(!wifiRow.content.includes('wifi-seguro-99'), 'la contraseña no está en claro en la base de datos');
  assert.equal(models.decryptWifiPassword({ wifiPasswordEnc: wifiContent.password_enc }), 'wifi-seguro-99');

  // 3. Página pública (huésped español): todos los bloques en orden
  const pubEs = await req(`/t/${tag.slug}`);
  assert.equal(pubEs.statusCode, 200);
  assert.match(pubEs.body, /Apartamento Centro 2B/);
  assert.match(pubEs.body, /4521#/);
  assert.match(pubEs.body, /Silencio de 23:00 a 9:00/);
  assert.match(pubEs.body, /La Bodega/);
  assert.match(pubEs.body, /https:\/\/wa\.me\/34600123456/);
  assert.match(pubEs.body, /g\.page\/r\/resena-es/);
  assert.match(pubEs.body, /data-wifi-connect/);
  // La contraseña viaja al huésped en el atributo data-wifi (necesaria para
  // conectar) pero NUNCA como texto visible ni en el SSID mostrado.
  assert.match(pubEs.body, /data-wifi='/);
  assert.ok(!pubEs.body.includes('>wifi-seguro-99<'), 'la contraseña no se muestra como texto de página');
  assert.ok(!pubEs.body.includes('Casa2Bwifi'), 'el SSID no va pegado a la contraseña');

  // 4. Huésped inglés: su acceso y reseña, el resto en español (fallback)
  const pubEn = await req(`/t/${tag.slug}`, { headers: { 'accept-language': 'en-GB,en;q=0.9' } });
  assert.equal(pubEn.statusCode, 200);
  assert.match(pubEn.body, /lang="en"/);
  assert.match(pubEn.body, /Door code 4521#/);
  assert.match(pubEn.body, /g\.page\/r\/review-en/);
  assert.match(pubEn.body, /Silencio de 23:00 a 9:00/, 'normas sin traducir salen en el idioma principal');

  // 5. La contraseña del WiFi del bloque no se loguea en el HTML del panel
  const detail = await get(`/admin/tags/${id}`);
  assert.equal(detail.statusCode, 200);
  assert.match(detail.body, /Guía del huésped/);
  assert.ok(!detail.body.includes('wifi-seguro-99'), 'el panel nunca muestra la contraseña de la guía');

  // 6. Editar manteniendo la contraseña (campo en blanco) y añadiendo EN wifi
  const editPage = await get(`/admin/tags/${id}/editar?modo=alojamiento`);
  assert.equal(editPage.statusCode, 200);
  const csrf2 = getCsrf(editPage.body);
  const editRes = await post(`/admin/tags/${id}`, {
    _csrf: csrf2,
    nombre: 'Apartamento Centro 2B',
    tipo: 'nfc',
    modo: 'alojamiento',
    estado: 'activo',
    aloj_idioma: 'es',
    b_es_present: '1',
    b_es_aloj_wifi_ssid: 'Casa2B',
    b_es_aloj_wifi_password: '',
    b_en_present: '1',
    b_en_aloj_wifi_ssid: 'Casa2B',
    b_en_aloj_wifi_password: 'english-pw-777'
  });
  assert.equal(editRes.statusCode, 302);
  const wifiEs2 = models.listBlocks(id).find((r) => r.block_type === 'wifi' && r.language === 'es');
  const wifiEn2 = models.listBlocks(id).find((r) => r.block_type === 'wifi' && r.language === 'en');
  assert.equal(models.decryptWifiPassword({ wifiPasswordEnc: JSON.parse(wifiEs2.content).password_enc }), 'wifi-seguro-99', 'al dejar la contraseña en blanco se conserva');
  assert.equal(models.decryptWifiPassword({ wifiPasswordEnc: JSON.parse(wifiEn2.content).password_enc }), 'english-pw-777');

  // 7. Modo despedida: prioriza la reseña al principio de la página
  const desp = await post(`/admin/tags/${id}/despedida`, { _csrf: csrf2 });
  assert.equal(desp.statusCode, 302);
  assert.equal(models.getTagById(id).modoDespedida, true);
  const pubDesp = await req(`/t/${tag.slug}`);
  const posAcceso = pubDesp.body.indexOf('4521#');
  const posResena = pubDesp.body.indexOf('g.page/r/resena-es');
  assert.ok(posResena > 0);
  assert.ok(posResena < posAcceso, 'en despedida la reseña aparece antes que el resto de bloques');
  // Quitar despedida restaura el orden normal
  await post(`/admin/tags/${id}/despedida`, { _csrf: csrf2 });
  assert.equal(models.getTagById(id).modoDespedida, false);

  // 8. Duplicar la propiedad: copia nombre nuevo + bloques completos
  const dupPage = await get('/admin/tags');
  const csrfDup = getCsrf(dupPage.body);
  const dupRes = await post(`/admin/tags/${id}/duplicar`, { _csrf: csrfDup, nombre: 'Apartamento Centro 3A' });
  assert.equal(dupRes.statusCode, 302);
  const dupId = Number(dupRes.headers.location.split('/').pop());
  assert.notEqual(dupId, id);
  const dup = models.getTagById(dupId);
  assert.equal(dup.nombre, 'Apartamento Centro 3A');
  assert.equal(dup.modo, 'alojamiento');
  const dupWifi = models.listBlocks(dupId).find((r) => r.block_type === 'wifi' && r.language === 'es');
  assert.equal(JSON.parse(dupWifi.content).ssid, 'Casa2B', 'los bloques se copian con la propiedad');

  // 9. Validación: WiFi sin contraseña → 400; URL de reseña inválida → 400
  const badWifi = await post('/admin/tags', {
    _csrf: csrf, nombre: 'Sin pw', tipo: 'qr', modo: 'alojamiento', estado: 'activo',
    b_es_present: '1', b_es_aloj_wifi_ssid: 'RedSinClave', b_es_aloj_wifi_password: ''
  });
  assert.equal(badWifi.statusCode, 400);
  assert.match(badWifi.body, /contraseña/i);

  const badUrl = await post('/admin/tags', {
    _csrf: csrf, nombre: 'URL mala', tipo: 'qr', modo: 'alojamiento', estado: 'activo',
    b_es_present: '1', b_es_resena_url: 'javascript:alert(1)'
  });
  assert.equal(badUrl.statusCode, 400);

  // 10. Cambiar a otro modo limpia los bloques (no quedan restos)
  await post(`/admin/tags/${dupId}`, {
    _csrf: csrf2, nombre: 'Apartamento Centro 3A', tipo: 'nfc', modo: 'desactivado', estado: 'activo'
  });
  assert.equal(models.listBlocks(dupId).length, 0);

  // 11. Eliminar la propiedad elimina también sus bloques
  await post(`/admin/tags/${id}/eliminar`, { _csrf: csrf2 });
  assert.equal(models.getTagById(id), null);
  assert.equal(models.listBlocks(id).length, 0);

  // Limpieza
  models.deleteTag(dupId);
});

test('venta de tarjeta → Alojamiento: el stock sin configurar se convierte en guía del huésped', async () => {
  const { cookie } = await loginAs('admin', 'secret123');
  const get = (path) => req(path, { cookie });
  const post = (path, body) => req(path, { method: 'POST', body, cookie });

  // 1. Stock pendiente de vender
  const stock = models.listTagsByModo('desactivado');
  assert.ok(stock.length >= 1);
  const target = stock[0];

  // 2. El dashboard ofrece «🏡 Alojamiento» para el tag vendido
  const dash = await get('/admin/tags');
  assert.match(dash.body, new RegExp(`/admin/tags/${target.id}/editar\\?modo=alojamiento`));

  // 3. La página de Alojamientos lista las tarjetas vendidas por configurar
  const alojs = await get('/admin/alojamientos');
  assert.match(alojs.body, /esperan configuración|espera configuración/);
  assert.ok(alojs.body.includes(`/admin/tags/${target.id}/editar?modo=alojamiento`));

  // 4. Configurar con el formato del editor de filas (b_{lang}_{block}_{n}_{campo})
  const editPage = await get(`/admin/tags/${target.id}/editar?modo=alojamiento`);
  assert.equal(editPage.statusCode, 200);
  const csrf = getCsrf(editPage.body);
  const saveRes = await post(`/admin/tags/${target.id}`, {
    _csrf: csrf,
    nombre: 'Ático Marina',
    tipo: 'nfc',
    modo: 'alojamiento',
    estado: 'activo',
    aloj_idioma: 'es',
    b_es_present: '1',
    b_es_acceso_texto: 'Portal 3B, 4º derecha. Llave bajo el felpudo.',
    b_es_aloj_wifi_ssid: 'MarinaWiFi',
    b_es_aloj_wifi_password: 'atico-marina-1',
    b_es_normas_present: '1',
    b_es_normas_0_text: 'No fiestas',
    b_es_normas_1_text: 'Reciclaje obligatorio',
    b_es_manual_present: '1',
    b_es_manual_0_title: 'Lavavajillas',
    b_es_manual_0_description: 'Pastillas en el cajón de abajo',
    b_es_manual_0_media_url: 'https://youtu.be/demo-lava',
    b_es_recomendaciones_present: '1',
    b_es_recomendaciones_0_title: 'Chiringuito Paco',
    b_es_recomendaciones_0_category: 'Restaurante',
    b_es_recomendaciones_0_description: 'A 5 min andando'
  });
  assert.equal(saveRes.statusCode, 302);

  const vendido = models.getTagById(target.id);
  assert.equal(vendido.modo, 'alojamiento');
  assert.equal(vendido.nombre, 'Ático Marina');

  // 5. Bloques guardados: normas como lista, manual con enlace, recomendaciones con categoría
  const rows = models.listBlocks(target.id);
  const normas = JSON.parse(rows.find((r) => r.block_type === 'normas').content);
  assert.deepEqual(normas.items.map((i) => i.text), ['No fiestas', 'Reciclaje obligatorio']);
  const manual = JSON.parse(rows.find((r) => r.block_type === 'manual').content);
  assert.equal(manual.items[0].title, 'Lavavajillas');
  assert.equal(manual.items[0].media_url, 'https://youtu.be/demo-lava');
  const recos = JSON.parse(rows.find((r) => r.block_type === 'recomendaciones').content);
  assert.equal(recos.items[0].title, 'Chiringuito Paco');
  assert.equal(recos.items[0].category, 'Restaurante');

  // 6. La página pública del huésped muestra todo
  const pub = await req(`/t/${vendido.slug}`);
  assert.equal(pub.statusCode, 200);
  assert.match(pub.body, /felpudo/);
  assert.match(pub.body, /No fiestas/);
  assert.match(pub.body, /Lavavajillas/);
  assert.match(pub.body, /youtu\.be\/demo-lava/);
  assert.match(pub.body, /Chiringuito Paco/);
  assert.match(pub.body, /Restaurante/);

  // Limpieza: devolver el tag a desactivado para otros tests
  models.updateTag(target.id, { modo: 'desactivado' });
  models.deleteBlocksByTag(target.id);
});

test('ver contraseña guardada: endpoint JSON y re-guardado sin cambios', async () => {
  models.createUser('pwadmin', bcrypt.hashSync('secret123', 4));
  const { cookie } = await loginAs('pwadmin', 'secret123');
  const get = (path) => req(path, { cookie });
  const post = (path, body) => req(path, { method: 'POST', body, cookie });

  // 1. Crear tag WiFi simple con contraseña
  const formPage = await get('/admin/tags/nuevo');
  const csrf = getCsrf(formPage.body);
  const createRes = await post('/admin/tags', {
    _csrf: csrf,
    nombre: 'WiFi Reveal Test',
    tipo: 'qr',
    modo: 'wifi',
    wifi_ssid: 'RedTest',
    wifi_password: 'ClaveSecreta99',
    wifi_seguridad: 'WPA',
    estado: 'activo'
  });
  assert.equal(createRes.statusCode, 302);
  const tagId = createRes.headers.location.split('/').pop();

  // 2. El endpoint devuelve la contraseña descifrada
  const json = await get(`/admin/tags/${tagId}/passwords.json`);
  assert.equal(json.statusCode, 200);
  const data = JSON.parse(json.body);
  assert.equal(data.wifi, 'ClaveSecreta99');
  assert.deepEqual(data.aloj, {});

  // 3. Cambiarla a otra y 4. re-guardar con el campo vacío mantiene la última
  const editPage = await get(`/admin/tags/${tagId}/editar`);
  const csrf2 = getCsrf(editPage.body);
  const updRes = await post(`/admin/tags/${tagId}`, {
    _csrf: csrf2,
    nombre: 'WiFi Reveal Test',
    tipo: 'qr',
    modo: 'wifi',
    wifi_ssid: 'RedTest',
    wifi_password: 'Reveal/Change#1',
    wifi_seguridad: 'WPA',
    estado: 'activo'
  });
  assert.equal(updRes.statusCode, 302);
  const editPage2 = await get(`/admin/tags/${tagId}/editar`);
  const csrf2b = getCsrf(editPage2.body);
  const updRes2 = await post(`/admin/tags/${tagId}`, {
    _csrf: csrf2b,
    nombre: 'WiFi Reveal Test',
    tipo: 'qr',
    modo: 'wifi',
    wifi_ssid: 'RedTest',
    wifi_password: '',
    wifi_seguridad: 'WPA',
    estado: 'activo'
  });
  assert.equal(updRes2.statusCode, 302);
  const json2 = JSON.parse((await get(`/admin/tags/${tagId}/passwords.json`)).body);
  assert.equal(json2.wifi, 'Reveal/Change#1');

  // 5. Un tag de alojamiento expone la contraseña por idioma y aislada del modo WiFi
  const alojPage = await get('/admin/tags/nuevo?modo=alojamiento');
  const csrf3 = getCsrf(alojPage.body);
  const alojRes = await post('/admin/tags', {
    _csrf: csrf3,
    nombre: 'Aloj Reveal',
    tipo: 'qr',
    modo: 'alojamiento',
    estado: 'activo',
    b_es_present: '1',
    b_es_aloj_wifi_ssid: 'RedAloj',
    b_es_aloj_wifi_password: 'ClaveAloj77',
    b_en_present: '1',
    b_en_aloj_wifi_ssid: 'RedAloj',
    b_en_aloj_wifi_password: 'Enclave44'
  });
  assert.equal(alojRes.statusCode, 302);
  const alojId = alojRes.headers.location.split('/').pop();
  const data3 = JSON.parse((await get(`/admin/tags/${alojId}/passwords.json`)).body);
  assert.equal(data3.wifi, '');
  assert.equal(data3.aloj.es, 'ClaveAloj77');
  assert.equal(data3.aloj.en, 'Enclave44');

  // 6. Sin sesión el endpoint no revela nada
  const anon = await req(`/admin/tags/${tagId}/passwords.json`);
  assert.equal(anon.statusCode, 302);

  // 7. Limpieza
  const delPage = await get(`/admin/tags/${tagId}`);
  const csrf4 = getCsrf(delPage.body);
  await post(`/admin/tags/${tagId}/eliminar`, { _csrf: csrf4 });
  const delPage2 = await get(`/admin/tags/${alojId}`);
  await post(`/admin/tags/${alojId}/eliminar`, { _csrf: getCsrf(delPage2.body) });
});

test('chip NFC: normalización de UID y lectura de modelo', () => {
  // Los UIDs llegan del móvil con separadores; se normalizan a hex mayúsculas.
  assert.equal(normalizeNfcUid('04:a3:b2:c1:5b:6a:80'), '04A3B2C15B6A80');
  assert.equal(normalizeNfcUid(' 04 A3 B2 C1 5B 6A 80 '), '04A3B2C15B6A80');
  assert.equal(normalizeNfcUid('04A3B2C15B6A80'), '04A3B2C15B6A80');
  assert.equal(normalizeNfcUid(''), null); // vacío = desvincular
  assert.equal(normalizeNfcUid('  '), null);
  assert.equal(normalizeNfcUid('XYZ'), false); // basura
  assert.equal(normalizeNfcUid('AB'), false); // demasiado corto (< 4 hex)
  assert.ok(normalizeNfcUid('04A3')); // 4 hex: válido
  assert.equal(normalizeNfcUid('04A3B2C15B6A80FF112233445566778899'), false); // demasiado largo
});

test('identificación del chip NFC: asociar, buscar en vivo, desvincular y unicidad', async () => {
  const { cookie } = await loginAs('admin', 'secret123');
  const get = (path) => req(path, { cookie });
  const post = (path, body) => req(path, { method: 'POST', body, cookie });
  const UID = '04A3B2C15B6A80';

  // 1. La página existe y aparece en el menú
  const page = await get('/admin/nfc');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Identificar chip NFC/);
  assert.match(page.body, /Leer chip NFC/);
  const csrf = getCsrf(page.body);

  // 2. Búsqueda en vivo: UID desconocido → no encontrado
  const miss = await get('/admin/nfc/buscar.json?uid=04:AA:BB:CC:DD:EE:FF');
  assert.equal(miss.statusCode, 200);
  const missData = JSON.parse(miss.body);
  assert.equal(missData.found, false);
  assert.equal(missData.uid, '04AABBCCDDEEFF');

  // 3. Crear una tarjeta de stock y asignarle el chip leído
  const stock = models.createBulkTags({ cantidad: 1, prefijo: 'Chip', tipo: 'nfc' });
  assert.equal(stock, 1);
  const target = models.listTagsByModo('desactivado').find((t) => t.nombre.startsWith('Chip '));

  const save = await post('/admin/nfc', { _csrf: csrf, uid: '04:a3:b2:c1:5b:6a:80', tag_id: String(target.id), modelo: 'ntag213' });
  assert.equal(save.statusCode, 302);

  const vinculado = models.getTagByNfcUid(UID);
  assert.ok(vinculado, 'el UID normalizado queda guardado');
  assert.equal(vinculado.id, target.id);
  assert.equal(vinculado.nfcModelo, 'NTAG213');

  // 4. La búsqueda en vivo ahora lo encuentra
  const hit = await get('/admin/nfc/buscar.json?uid=04A3B2C15B6A80');
  const hitData = JSON.parse(hit.body);
  assert.equal(hitData.found, true);
  assert.equal(hitData.nombre, target.nombre);

  // 5. Unicidad: asignar el mismo chip a otra ficha lo reasigna
  const otro = models.createBulkTags({ cantidad: 1, prefijo: 'Chip', tipo: 'nfc' });
  assert.equal(otro, 1);
  const otroTag = models.listTagsByModo('desactivado').find((t) => t.nombre.startsWith('Chip ') && t.id !== target.id);
  const reassign = await post('/admin/nfc', { _csrf: csrf, uid: UID, tag_id: String(otroTag.id), modelo: '' });
  assert.equal(reassign.statusCode, 302);
  assert.equal(models.getTagByNfcUid(UID).id, otroTag.id);
  assert.equal(models.getTagById(target.id).nfcUid, null);

  // 6. Desvincular
  const unlink = await post('/admin/nfc', { _csrf: csrf, uid: UID, accion: 'desvincular' });
  assert.equal(unlink.statusCode, 302);
  assert.equal(models.getTagByNfcUid(UID), null);

  // 7. El UID también se puede guardar desde el formulario del tag (con ?uid=)
  const edit = await get(`/admin/tags/${target.id}/editar?uid=04:11:22:33:44:55:66`);
  assert.equal(edit.statusCode, 200);
  const prefilled = models.getTagById(target.id);
  assert.equal(prefilled.nfcUid, '04112233445566');

  // Y el formulario admite el campo en el POST normal (y desvincula en blanco)
  const editPage = await get(`/admin/tags/${target.id}/editar`);
  const csrf2 = getCsrf(editPage.body);
  const save2 = await post(`/admin/tags/${target.id}`, {
    _csrf: csrf2,
    nombre: prefilled.nombre,
    tipo: 'nfc',
    modo: 'desactivado',
    estado: 'activo',
    nfc_uid: '04112233445566',
    nfc_modelo: 'NTAG213'
  });
  assert.equal(save2.statusCode, 302);
  assert.equal(models.getTagById(target.id).nfcUid, '04112233445566');

  const save3 = await post(`/admin/tags/${target.id}`, {
    _csrf: csrf2,
    nombre: prefilled.nombre,
    tipo: 'nfc',
    modo: 'desactivado',
    estado: 'activo',
    nfc_uid: '',
    nfc_modelo: ''
  });
  assert.equal(save3.statusCode, 302);
  assert.equal(models.getTagById(target.id).nfcUid, null);

  // Limpieza de las tarjetas de prueba
  models.deleteTag(target.id);
  models.deleteTag(otroTag.id);
});
