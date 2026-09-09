'use strict';

// Geolocalización aproximada por IP (best-effort). No bloquea el escaneo: se
// resuelve en segundo plano y, si falla, el escaneo se guarda igualmente sin
// ubicación. La IP real solo se envía al proveedor de geolocalización; en la
// base de datos solo se guarda la ubicación resultante (y el hash de la IP).

const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const cache = new Map(); // ip -> { city, region, country, lat, lon, ts }

async function fetchJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Normaliza la IP y descarta direcciones privadas/de bucle local (imposibles
// de geolocalizar, y además evitan peticiones de red en tests locales).
function normalizeIp(ip) {
  let value = String(ip || '').trim();
  if (!value) return null;
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (value === '::1' || value === '127.0.0.1' || value === 'localhost') return null;
  return value;
}

async function ipToLocation(ip) {
  const clean = normalizeIp(ip);
  if (!clean) return null;

  const cached = cache.get(clean);
  if (cached && Date.now() - cached.ts < GEO_CACHE_TTL_MS) return cached;

  let result = null;

  // Proveedor principal: ipwho.is (gratuito, sin clave, HTTPS).
  const data = await fetchJson(`https://ipwho.is/${encodeURIComponent(clean)}`);
  if (data && data.success) {
    result = {
      city: data.city || null,
      region: data.region || null,
      country: data.country || null,
      lat: typeof data.latitude === 'number' ? data.latitude : null,
      lon: typeof data.longitude === 'number' ? data.longitude : null
    };
  }

  if (!result) {
    // Respaldo: ip-api.com (gratuito, sin clave, 45 req/min).
    const alt = await fetchJson(
      `http://ip-api.com/json/${encodeURIComponent(clean)}?fields=status,city,regionName,country,lat,lon`
    );
    if (alt && alt.status === 'success') {
      result = {
        city: alt.city || null,
        region: alt.regionName || null,
        country: alt.country || null,
        lat: typeof alt.lat === 'number' ? alt.lat : null,
        lon: typeof alt.lon === 'number' ? alt.lon : null
      };
    }
  }

  if (result) cache.set(clean, { ...result, ts: Date.now() });
  return result;
}

module.exports = { ipToLocation };