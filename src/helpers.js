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

// Escape para interpolación segura en atributos HTML desde EJS.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Genera las series de escaneos por periodo (día/semana/mes/año) a partir de
// marcas de tiempo ISO (UTC). Devuelve buckets de longitud fija terminados en
// hoy: 30 días, 12 semanas, 12 meses y 5 años. Los huecos quedan a 0 para que
// la gráfica muestre siempre el eje temporal completo.
function buildScanSeries(timestamps) {
  const DAY = 86400000;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const now = today.getTime();

  // Clave de bucket para cada escala (semana y mes empiezan el lunes / día 1).
  const weekKey = (t) => {
    const d = new Date(t);
    const day = (d.getUTCDay() + 6) % 7; // lunes = 0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  };
  const monthKey = (t) => {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  };
  const yearKey = (t) => {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), 0, 1);
  };

  const daily = [];
  const dailyIdx = new Map();
  for (let i = 29; i >= 0; i--) {
    const key = now - i * DAY;
    daily.push({ label: fmtDayLabel(key), count: 0 });
    dailyIdx.set(key, daily.length - 1);
  }
  const weekly = [];
  const weeklyIdx = new Map();
  for (let i = 11; i >= 0; i--) {
    const key = weekKey(now - i * 7 * DAY);
    weekly.push({ label: fmtWeekLabel(key), count: 0 });
    weeklyIdx.set(key, weekly.length - 1);
  }
  const monthly = [];
  const monthlyIdx = new Map();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    monthly.push({ label: fmtMonthLabel(key), count: 0 });
    monthlyIdx.set(key, monthly.length - 1);
  }
  const yearly = [];
  const yearlyIdx = new Map();
  for (let i = 4; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCFullYear(d.getUTCFullYear() - i);
    const key = Date.UTC(d.getUTCFullYear(), 0, 1);
    yearly.push({ label: String(d.getUTCFullYear()), count: 0 });
    yearlyIdx.set(key, yearly.length - 1);
  }

  for (const raw of timestamps) {
    const t = new Date(raw).getTime();
    if (Number.isNaN(t)) continue;
    const di = dailyIdx.get(Math.floor(t / DAY) * DAY);
    if (di != null) daily[di].count++;
    const wi = weeklyIdx.get(weekKey(t));
    if (wi != null) weekly[wi].count++;
    const mi = monthlyIdx.get(monthKey(t));
    if (mi != null) monthly[mi].count++;
    const yi = yearlyIdx.get(yearKey(t));
    if (yi != null) yearly[yi].count++;
  }

  return { daily, weekly, monthly, yearly };
}

function fmtDayLabel(t) {
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function fmtWeekLabel(t) {
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTH_NAMES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function fmtMonthLabel(t) {
  const d = new Date(t);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
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

module.exports = { fmtDate, detectOS, osLabel, publicBaseUrl, tagPublicUrl, isHttpUrl, hashIp, clientIp, escapeHtml, buildScanSeries, fmtLocation, mapsUrl };
