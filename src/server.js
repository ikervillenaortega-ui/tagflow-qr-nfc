'use strict';
const crypto = require('crypto');
const config = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');

const db = openDb(config.dbPath);

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

const app = createApp({ config, db });

app.listen(config.port, () => {
  console.log(`[${config.appName}] Panel:   http://localhost:${config.port}/admin`);
  console.log(`[${config.appName}] Público: http://localhost:${config.port}/t/{slug}`);
  console.log(`[${config.appName}] DB:      ${config.dbPath}`);
  if (!config.isProd) {
    console.log('[aviso] Modo desarrollo: revisa SESSION_SECRET y WIFI_SECRET en .env antes de desplegar.');
  }
});