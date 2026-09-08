'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { openDb } = require('./db');
const { createModels } = require('./models');
const { createApp } = require('./app');

const db = openDb(config.dbPath);
const models = createModels(db, config);

// Limpieza de sesiones caducadas al arrancar.
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

// Secretos: si no vienen por variables de entorno, se generan una vez y se
// persisten en la tabla `meta` para sobrevivir a reinicios sin configuración.
function getOrCreateSecret(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (row && row.value) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, secret);
  return secret;
}
if (!config.sessionSecret) config.sessionSecret = getOrCreateSecret('session_secret');
if (!config.wifiSecret) config.wifiSecret = getOrCreateSecret('wifi_secret');

// Primer arranque: si no hay ningún usuario, se crea el admin por defecto para
// que el panel sea accesible sin configuración previa. Si vienen
// ADMIN_USERNAME/ADMIN_PASSWORD por entorno, se crea o actualiza ese usuario
// (útil para fijar credenciales en el despliegue).
function ensureAdmin(username, password) {
  const existing = models.findUserByUsername(username);
  const hash = bcrypt.hashSync(password, 10);
  if (existing) {
    models.updateUserPassword(existing.id, hash);
  } else {
    models.createUser(username, hash);
  }
}
const DEFAULT_ADMIN = {
  username: process.env.ADMIN_USERNAME || 'Iker',
  password: process.env.ADMIN_PASSWORD || 'Iker2009'
};
if (process.env.ADMIN_USERNAME || process.env.ADMIN_PASSWORD) {
  ensureAdmin(DEFAULT_ADMIN.username, DEFAULT_ADMIN.password);
  console.log(`[${config.appName}] Admin «${DEFAULT_ADMIN.username}» creado/actualizado con las credenciales de ADMIN_USERNAME/ADMIN_PASSWORD.`);
} else if (!db.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
  ensureAdmin(DEFAULT_ADMIN.username, DEFAULT_ADMIN.password);
  console.log(`[${config.appName}] Admin por defecto creado: «${DEFAULT_ADMIN.username}» (cámbiala con npm run create-admin).`);
}

const app = createApp({ config, db });

app.listen(config.port, () => {
  console.log(`[${config.appName}] Panel:   http://localhost:${config.port}/admin`);
  console.log(`[${config.appName}] Público: http://localhost:${config.port}/t/{slug}`);
  console.log(`[${config.appName}] DB:      ${config.dbPath}`);
  if (!config.isProd) {
    console.log('[aviso] Modo desarrollo: revisa SESSION_SECRET y WIFI_SECRET en .env antes de desplegar.');
  }
});