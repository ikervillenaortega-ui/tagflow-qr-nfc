'use strict';
const config = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');

const db = openDb(config.dbPath);

// Limpieza de sesiones caducadas al arrancar.
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

const app = createApp({ config, db });

app.listen(config.port, () => {
  console.log(`[${config.appName}] Panel:   http://localhost:${config.port}/admin`);
  console.log(`[${config.appName}] Público: http://localhost:${config.port}/t/{slug}`);
  console.log(`[${config.appName}] DB:      ${config.dbPath}`);
  if (!config.isProd) {
    console.log('[aviso] Modo desarrollo: revisa SESSION_SECRET y WIFI_SECRET en .env antes de desplegar.');
  }
});