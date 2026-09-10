'use strict';
// Módulo de Alojamientos Turísticos.
//
// Un tag en modo 'alojamiento' presenta al huésped una guía editable por
// bloques (acceso, WiFi, normas, manual, recomendaciones, contacto, reseña).
// El contenido vive en la tabla tag_blocks (una fila por bloque, idioma y
// tag) como JSON libre; la contraseña WiFi del bloque se cifra con AES-256-GCM
// (la misma clave que el resto de la app) y nunca viaja al panel ni al HTML
// como texto plano legible.

const { encryptText, decryptText } = require('./crypto');

const BLOCK_TYPES = ['acceso', 'wifi', 'normas', 'manual', 'recomendaciones', 'contacto', 'resena'];

// Orden de visualización en la página pública (los bloques vacíos no se muestran).
const BLOCK_ORDER = ['acceso', 'wifi', 'normas', 'manual', 'recomendaciones', 'contacto', 'resena'];

// Idiomas soportados en la primera versión (extensible: añadir aquí y a los
// selectores del formulario; la resolución de idioma ya es data-driven).
const LANGUAGES = ['es', 'en'];
const LANGUAGE_NAMES = { es: 'Español', en: 'English' };

// Etiquetas de bloque para el panel (detail/dashboard).
const BLOCK_LABELS = {
  acceso: '🔑 Acceso',
  wifi: '📶 WiFi',
  normas: '📋 Normas',
  manual: '🏠 Manual',
  recomendaciones: '📍 Recomendaciones',
  contacto: '💬 Contacto',
  resena: '⭐ Reseña'
};

const MAX_TEXT = 3000;

// ---------- utilidades ----------

function str(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function nowIso() {
  return new Date().toISOString();
}

function isHttpUrl(v) {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseJson(v) {
  try { return JSON.parse(v); } catch { return null; }
}

// Puntos de una lista: acepta string (una línea por punto) o array.
function cleanList(value, { maxItems = 40, maxLen = 300 } = {}) {
  let items = [];
  if (Array.isArray(value)) {
    items = value.map((it) => (typeof it === 'string' ? it : it && it.text));
  } else if (typeof value === 'string') {
    items = value.split(/\r?\n/);
  }
  const out = [];
  for (const it of items) {
    const text = str(it).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({ text: text.slice(0, maxLen) });
    if (out.length >= maxItems) break;
  }
  return out;
}

// Items del manual de electrodomésticos: una línea por aparato con campos
// separados por «|»:  «Título | Descripción | Enlace vídeo/foto (opcional)».
function cleanManualItems(value, { maxItems = 30 } = {}) {
  let lines = [];
  if (Array.isArray(value)) {
    const out = [];
    for (const it of value) {
      const o = it || {};
      const entry = {};
      if (str(o.title).trim()) entry.title = str(o.title).trim().slice(0, 120);
      if (str(o.description).trim()) entry.description = str(o.description).trim().slice(0, 500);
      if (o.media_url && isHttpUrl(o.media_url)) entry.media_url = str(o.media_url).slice(0, 2048);
      if (entry.title) {
        out.push(entry);
        if (out.length >= maxItems) break;
      }
    }
    return out;
  }
  if (typeof value === 'string') lines = value.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const parts = line.split('|').map((p) => p.trim());
    const title = parts[0] || '';
    if (!title) continue;
    const entry = { title: title.slice(0, 120) };
    if (parts[1]) entry.description = parts[1].slice(0, 500);
    if (parts[2] && isHttpUrl(parts[2])) entry.media_url = parts[2].slice(0, 2048);
    out.push(entry);
    if (out.length >= maxItems) break;
  }
  return out;
}

// Items de recomendaciones locales: «Nombre | Categoría | Nota corta (opcional)».
function cleanRecommendationItems(value, { maxItems = 30 } = {}) {
  let lines = [];
  if (Array.isArray(value)) {
    const out = [];
    for (const it of value) {
      const o = it || {};
      const entry = {};
      if (str(o.title).trim()) entry.title = str(o.title).trim().slice(0, 120);
      if (str(o.category).trim()) entry.category = str(o.category).trim().slice(0, 60);
      if (str(o.description).trim()) entry.description = str(o.description).trim().slice(0, 500);
      if (entry.title) {
        out.push(entry);
        if (out.length >= maxItems) break;
      }
    }
    return out;
  }
  if (typeof value === 'string') lines = value.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const parts = line.split('|').map((p) => p.trim());
    const title = parts[0] || '';
    if (!title) continue;
    const entry = { title: title.slice(0, 120) };
    if (parts[1]) entry.category = parts[1].slice(0, 60);
    if (parts[2]) entry.description = parts[2].slice(0, 500);
    out.push(entry);
    if (out.length >= maxItems) break;
  }
  return out;
}

// ---------- validación de entrada (panel) ----------

// Normaliza y valida el cuerpo del formulario de bloques (un idioma a la vez).
// Devuelve { errors, blocks, idioma } donde blocks contiene SOLO los bloques
// rellenados (los ausentes no se tocan al guardar).
function validateAlojamientoInput(body, opts = {}) {
  const errors = [];
  const blocks = {};

  const idioma = LANGUAGES.includes(body.aloj_idioma) ? body.aloj_idioma : 'es';

  // --- Acceso (texto libre, opcional) ---
  const acceso = str(body.acceso_texto).trim().slice(0, MAX_TEXT);
  if (acceso) blocks.acceso = { texto: acceso };

  // --- WiFi (SSID + contraseña cifrada; nada se muestra como texto visible) ---
  const wifiSsid = str(body.aloj_wifi_ssid).trim();
  const wifiPassword = str(body.aloj_wifi_password);
  const keepWifiPassword = str(body.aloj_wifi_keep_password) === '1';
  if (wifiSsid) {
    if (wifiSsid.length > 64) {
      errors.push('El SSID del WiFi no puede superar los 64 caracteres.');
    }
    const existing = opts.existingWifi || null;
    if (!keepWifiPassword && wifiPassword && (wifiPassword.length < 5 || wifiPassword.length > 64)) {
      errors.push('La contraseña del WiFi debe tener entre 5 y 64 caracteres.');
    }
    if (!wifiPassword && !(existing && existing.password_enc)) {
      errors.push('Introduce la contraseña del WiFi (o la red quedaría abierta).');
    }
    let passwordEnc = null;
    if (wifiPassword) {
      // Contraseña nueva: se cifra en este momento y no vuelve a aparecer.
      if (wifiPassword.length >= 5 && wifiPassword.length <= 64) {
        passwordEnc = encryptText(wifiPassword, opts.secret);
      }
    } else if (existing && existing.password_enc) {
      // Campo en blanco: se conserva la cifrada que ya había.
      passwordEnc = existing.password_enc;
    }
    blocks.wifi = { ssid: wifiSsid, password_enc: passwordEnc, security: 'WPA' };
  }

  // --- Normas: lista de puntos (una por línea) ---
  const normas = cleanList(body.normas_texto);
  if (normas.length) blocks.normas = { items: normas };

  // --- Manual de electrodomésticos: «Título | Descripción | Enlace vídeo/foto» ---
  const manual = cleanManualItems(body.manual_texto);
  if (manual.length) blocks.manual = { items: manual };

  // --- Recomendaciones locales: «Nombre | Categoría | Nota corta» ---
  const recos = cleanRecommendationItems(body.recomendaciones_texto);
  if (recos.length) blocks.recomendaciones = { items: recos };

  // --- Contacto: WhatsApp / teléfono / correo (nunca visibles en texto plano) ---
  // WhatsApp exige formato internacional (wa.me lo necesita); el teléfono de
  // llamada admite también formato local.
  const wa = str(body.aloj_contacto_whatsapp).replace(/[^+0-9]/g, '').slice(0, 20);
  if (wa && !/^\+[0-9]{6,20}$/.test(wa)) {
    errors.push('El número de WhatsApp debe empezar por + y contener solo dígitos (formato internacional, sin espacios).');
  }
  const tel = str(body.aloj_contacto_telefono).replace(/[^+0-9]/g, '').slice(0, 20);
  if (tel && !/^\+?[0-9]{6,20}$/.test(tel)) {
    errors.push('El teléfono de contacto debe contener solo dígitos (y opcionalmente el + inicial).');
  }
  const email = str(body.aloj_contacto_email).trim().toLowerCase();
  if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))) {
    errors.push('El correo electrónico de contacto no parece válido.');
  }
  if (wa || tel || email) {
    blocks.contacto = { whatsapp: wa || null, telefono: tel || null, email: email || null };
  }

  // --- Enlace de reseña ---
  const resenaUrl = str(body.resena_url).trim();
  if (resenaUrl) {
    if (!isHttpUrl(resenaUrl)) {
      errors.push('El enlace de reseña debe empezar por http:// o https://.');
    } else {
      blocks.resena = { url: resenaUrl };
    }
  }

  return { errors, blocks, idioma };
}

// ---------- resolución de idioma ----------

// Accept-Language del navegador → traducción disponible en ese idioma; si no
// existe, el idioma principal configurado por el anfitrión.
function resolveLanguage(acceptLanguage, defaultLanguage) {
  const def = LANGUAGES.includes(defaultLanguage) ? defaultLanguage : 'es';
  const al = String(acceptLanguage || '').toLowerCase();
  if (!al) return def;
  const prefs = [];
  for (const part of al.split(',')) {
    const segs = part.trim().split(';');
    const tag = (segs[0] || '').trim();
    let q = 1;
    for (let i = 1; i < segs.length; i++) {
      const m = /^q=([0-9.]+)$/.exec(segs[i].trim());
      if (m) q = parseFloat(m[1]) || 0;
    }
    const base = tag.split('-')[0];
    if (base) prefs.push({ lang: base, q });
  }
  prefs.sort((a, b) => b.q - a.q);
  for (const { lang } of prefs) {
    if (LANGUAGES.includes(lang)) return lang;
  }
  return def;
}

// ---------- vista del huésped ----------

// Compone la página del huésped a partir de las filas de tag_blocks del tag:
// elige la traducción del idioma resuelto y, si no existe, la del idioma
// principal; descifra la contraseña WiFi solo aquí; y devuelve únicamente los
// bloques rellenados y visibles, en orden fijo.
function buildGuestView({ blockRows, acceptLanguage, defaultLanguage, secret }) {
  const lang = resolveLanguage(acceptLanguage, defaultLanguage);
  const def = LANGUAGES.includes(defaultLanguage) ? defaultLanguage : 'es';

  // Por cada bloque: fila del idioma resuelto si existe; si no, fila del
  // idioma principal; si no, la mejor traducción disponible (p. ej. solo 'en').
  const pick = new Map();
  for (const r of blockRows || []) {
    if (!r.is_visible) continue;
    if (r.language === lang) pick.set(r.block_type, r);
  }
  for (const r of blockRows || []) {
    if (!r.is_visible) continue;
    if (r.language === def && !pick.has(r.block_type)) pick.set(r.block_type, r);
  }
  for (const r of blockRows || []) {
    if (!r.is_visible) continue;
    if (!pick.has(r.block_type)) pick.set(r.block_type, r);
  }

  const view = { lang, def, blocks: [] };
  for (const type of BLOCK_ORDER) {
    const row = pick.get(type);
    if (!row) continue;
    const c = parseJson(row.content);
    if (!c) continue;

    if (type === 'acceso') {
      const texto = str(c.texto).trim();
      if (!texto) continue;
      view.blocks.push({ type, texto });
      continue;
    }
    if (type === 'wifi') {
      const ssid = str(c.ssid).trim();
      if (!ssid) continue;
      let password = '';
      if (c.password_enc) {
        try { password = decryptText(c.password_enc, secret); } catch { password = ''; }
      }
      view.blocks.push({
        type,
        ssid,
        password,
        security: c.security === 'nopass' ? 'nopass' : (c.security === 'WEP' ? 'WEP' : 'WPA')
      });
      continue;
    }
    if (type === 'normas') {
      const items = Array.isArray(c.items) ? c.items.filter((i) => i && str(i.text).trim()) : [];
      if (!items.length) continue;
      view.blocks.push({ type, items: items.slice(0, 40) });
      continue;
    }
    if (type === 'manual') {
      const items = Array.isArray(c.items) ? c.items.filter((i) => i && str(i.title).trim()) : [];
      if (!items.length) continue;
      view.blocks.push({ type, items: items.slice(0, 30) });
      continue;
    }
    if (type === 'recomendaciones') {
      const items = Array.isArray(c.items) ? c.items.filter((i) => i && str(i.title).trim()) : [];
      if (!items.length) continue;
      view.blocks.push({ type, items: items.slice(0, 30) });
      continue;
    }
    if (type === 'contacto') {
      if (!c.whatsapp && !c.telefono && !c.email) continue;
      view.blocks.push({
        type,
        whatsapp: str(c.whatsapp || ''),
        telefono: str(c.telefono || ''),
        email: str(c.email || '')
      });
      continue;
    }
    if (type === 'resena') {
      const url = str(c.url).trim();
      if (!url || !isHttpUrl(url)) continue;
      view.blocks.push({ type, url });
    }
  }
  return view;
}

module.exports = {
  BLOCK_TYPES,
  BLOCK_ORDER,
  LANGUAGES,
  LANGUAGE_NAMES,
  BLOCK_LABELS,
  validateAlojamientoInput,
  resolveLanguage,
  buildGuestView
};
