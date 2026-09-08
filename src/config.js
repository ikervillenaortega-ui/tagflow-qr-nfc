'use strict';
const path = require('path');
const dotenv = require('dotenv');

const root = path.join(__dirname, '..');
dotenv.config({ path: path.join(root, '.env') });

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function toInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) ? fallback : n;
}

function secret(name, devDefault) {
  const value = env[name] && String(env[name]).trim();
  if (value) {
    if (value.length < 16) {
      throw new Error(`${name} debe tener al menos 16 caracteres. Revisa .env y README.md.`);
    }
    return value;
  }
  if (isProd) {
    // En producción sin variable definida no se aborta: server.js genera un
    // secreto aleatorio y lo persiste en la base de datos (tabla meta), de modo
    // que el despliegue funciona sin configuración previa (p. ej. en Render).
    console.log(`[config] ${name} sin definir: se generará y persistirá en la base de datos.`);
    return null;
  }
  console.log(`[config] Aviso: ${name} sin definir. Usando valor de desarrollo (¡no usar en producción!).`);
  return devDefault;
}

module.exports = {
  root,
  isProd,
  port: toInt(env.PORT, 3000),
  appName: env.APP_NAME || 'TagFlow',
  baseUrl: String(env.BASE_URL || '').replace(/\/+$/, ''),
  dbPath: env.DB_PATH ? path.resolve(root, env.DB_PATH) : path.join(root, 'data', 'app.db'),
  sessionSecret: secret('SESSION_SECRET', 'dev-session-secret-0123456789abcdef'),
  wifiSecret: secret('WIFI_SECRET', 'dev-wifi-secret-0123456789abcdef'),
  // En producción se asume HTTPS detrás de un proxy (Render, Nginx, Cloudflare…);
  // puede desactivarse explícitamente con COOKIE_SECURE=false / TRUST_PROXY=false.
  cookieSecure: env.COOKIE_SECURE === 'true' || (isProd && env.COOKIE_SECURE !== 'false'),
  trustProxy: env.TRUST_PROXY === 'true' || (isProd && env.TRUST_PROXY !== 'false'),
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000
};