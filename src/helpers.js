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

// IP real del cliente detrás de proxies encadenados (Render, Cloudflare, …):
// la primera entrada de X-Forwarded-For es la original; si no viene, se usa la
// dirección de socket (req.ip ya resuelta por Express).
function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return (req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

// Texto legible de la ubicación de un escaneo: «Ciudad, Región, País».
function fmtLocation(scan) {
  const parts = [scan && scan.city, scan && scan.region, scan && scan.country].filter(Boolean);
  return parts.length ? parts.join(', ') : '';
}

// Enlace a Google Maps desde unas coordenadas (si existen).
function mapsUrl(lat, lon) {
  if (lat == null || lon == null) return '';
  return `https://www.google.com/maps?q=${encodeURIComponent(lat)},${encodeURIComponent(lon)}`;
}

module.exports = { fmtDate, detectOS, osLabel, publicBaseUrl, tagPublicUrl, isHttpUrl, hashIp, clientIp, fmtLocation, mapsUrl };