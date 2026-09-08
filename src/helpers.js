'use strict';
const crypto = require('crypto');

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}

// Detección básica de sistema operativo desde el User-Agent.
function detectOS(userAgent = '') {
  const ua = String(userAgent);
  if (/android/i.test(ua)) return 'android';
  if (/(iphone|ipad|ipod)/i.test(ua)) return 'ios';
  if (/mac os x/i.test(ua) && /mobile/i.test(ua)) return 'ios';
  return 'other';
}

const OS_LABELS = { android: 'Android', ios: 'iOS', other: 'Otro dispositivo' };

function osLabel(os) {
  return OS_LABELS[os] || 'Otro dispositivo';
}

// URL base pública: la configurada o la deducida de la petición.
function publicBaseUrl(req, config) {
  if (config.baseUrl) return config.baseUrl;
  return `${req.protocol}://${req.get('host')}`;
}

function tagPublicUrl(baseUrl, slug) {
  return `${baseUrl}/t/${encodeURIComponent(slug)}`;
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Hash corto de la IP para estadísticas sin guardar datos personales.
function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 16);
}

module.exports = { fmtDate, detectOS, osLabel, publicBaseUrl, tagPublicUrl, isHttpUrl, hashIp };