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
  if (value && value.length >= 16) return value;
  if (isProd) {
    throw new Error(
      `Falta la variable de entorno ${name} (mínimo 16 caracteres). Revisa .env y README.md antes de desplegar.`
    );
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
  cookieSecure: env.COOKIE_SECURE === 'true',
  trustProxy: env.TRUST_PROXY === 'true',
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000
};