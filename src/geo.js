'use strict';

// Geolocalización aproximada por IP (best-effort). No bloquea el escaneo: se
// resuelve en segundo plano y, si falla, el escaneo se guarda igualmente sin
// ubicación. La IP real solo se envía al proveedor de geolocalización; en la
// base de datos solo se guarda la ubicación resultante (y el hash de la IP).

const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const cache = new Map(); // ip -> { city, region, country, lat, lon, ts }

async function fetchJson(url, timeoutMs = 8000) {
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
  // Devuelve { geo, note }: geo con la ubicación (o null) y note con el motivo
  // cuando no se pudo resolver, para mostrarlo en el panel.
  const clean = normalizeIp(ip);
  if (!clean) return { geo: null, note: 'IP privada o local: imposible geolocalizar' };

  const cached = cache.get(clean);
  if (cached && Date.now() - cached.ts < GEO_CACHE_TTL_MS) {
    return cached.geo ? { geo: cached.geo, note: null } : { geo: null, note: cached.note };
  }

  let result = null;

  // Proveedor principal: ipwho.is (gratuito, sin clave, HTTPS, uso comercial permitido).
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
    // Respaldo 1: freeipapi.com (gratuito, sin clave, HTTPS; admite IPs de datacenter).
    const alt = await fetchJson(`https://freeipapi.com/api/json/${encodeURIComponent(clean)}`);
    if (alt && alt.ipAddress && typeof alt.latitude === 'number') {
      result = {
        city: alt.cityName || null,
        region: alt.regionName || null,
        country: alt.countryName || null,
        lat: alt.latitude,
        lon: alt.longitude
      };
    }
  }

  if (!result) {
    // Respaldo 2: ip-api.com (gratuito, sin clave, 45 req/min, solo uso personal).
    const alt2 = await fetchJson(
      `http://ip-api.com/json/${encodeURIComponent(clean)}?fields=status,city,regionName,country,lat,lon`
    );
    if (alt2 && alt2.status === 'success') {
      result = {
        city: alt2.city || null,
        region: alt2.regionName || null,
        country: alt2.country || null,
        lat: typeof alt2.lat === 'number' ? alt2.lat : null,
        lon: typeof alt2.lon === 'number' ? alt2.lon : null
      };
    }
  }

  if (result) {
    cache.set(clean, { geo: result, note: null, ts: Date.now() });
    return { geo: result, note: null };
  }
  cache.set(clean, { geo: null, note: 'El proveedor de geolocalización no respondió', ts: Date.now() });
  return { geo: null, note: 'El proveedor de geolocalización no respondió' };
}

module.exports = { ipToLocation };