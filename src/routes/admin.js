'use strict';
const fs = require('fs');
const express = require('express');
const archiver = require('archiver');
const { backupToFile, restoreFromFile, isValidSqliteBuffer, tempPath } = require('../backup');
const { publicBaseUrl, tagPublicUrl, detectOS, osLabel, isHttpUrl, fmtLocation, mapsUrl, buildScanSeries } = require('../helpers');
const { buildWifiString } = require('../wifi');
const { buildVCard } = require('../contact');
const { qrPng, qrSvg } = require('../qr');
const { isValidSlug } = require('../slugs');
const { circularSvg } = require('../imageUtils');
const { decryptText } = require('../crypto');
const { BLOCK_TYPES, LANGUAGES, LANGUAGE_NAMES, validateAlojamientoInput, BLOCK_LABELS } = require('../alojamiento');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Bloques de alojamiento de un tag agrupados por idioma y tipo (para las
// pestañas de idioma del formulario de edición).
function blocksByLangFor(models, tag) {
  const out = {};
  if (!tag) return out;
  for (const row of models.listBlocks(tag.id)) {
    let content = null;
    try { content = JSON.parse(row.content); } catch { content = null; }
    out[row.language] = out[row.language] || {};
    out[row.language][row.block_type] = content;
  }
  return out;
}

// ---------- Modo Alojamiento: extracción y persistencia por idioma ----------

// Los formularios traen los bloques por idioma con el prefijo b_{idioma}_.
// El editor de filas envía b_{idioma}_{bloque}_{n}_{campo} y un marker
// b_{idioma}_{bloque}_present; el formato legado enviaba un textarea con
// líneas «a|b|c». Ambos se convierten al cuerpo que espera
// validateAlojamientoInput y se validan todos los idiomas marcados.
function collectRows(body, lang, kind, fields) {
  if (body[`b_${lang}_${kind}_present`] === undefined) return undefined;
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const values = {};
    let seen = false;
    for (const f of fields) {
      const raw = body[`b_${lang}_${kind}_${i}_${f}`];
      if (raw !== undefined) { values[f] = String(raw); seen = true; }
    }
    if (!seen) break;
    rows.push(values);
  }
  return rows;
}

function collectAlojamiento(body, tag, models, secret) {
  const existingWifi = new Map();
  if (tag) {
    for (const row of models.listBlocks(tag.id)) {
      if (row.block_type !== 'wifi') continue;
      try { existingWifi.set(row.language, JSON.parse(row.content)); } catch { /* fila corrupta: se ignora */ }
    }
  }
  // Todos los idiomas que el formulario trae marcados (0 o 1): los marcados
  // con 0 se validan vacíos y al guardar limpian bloques obsoletos de ese idioma.
  const langs = LANGUAGES.filter((lang) => body[`b_${lang}_present`] !== undefined);
  const errors = [];
  const perLang = new Map();
  for (const lang of langs) {
    const sub = {
      aloj_idioma: lang,
      acceso_texto: body[`b_${lang}_acceso_texto`],
      aloj_wifi_ssid: body[`b_${lang}_aloj_wifi_ssid`],
      aloj_wifi_password: body[`b_${lang}_aloj_wifi_password`],
      normas_texto: collectRows(body, lang, 'normas', ['text']) ?? body[`b_${lang}_normas_texto`],
      manual_texto: collectRows(body, lang, 'manual', ['title', 'description', 'media_url']) ?? body[`b_${lang}_manual_texto`],
      recomendaciones_texto: collectRows(body, lang, 'recomendaciones', ['title', 'category', 'description']) ?? body[`b_${lang}_recomendaciones_texto`],
      aloj_contacto_whatsapp: body[`b_${lang}_aloj_contacto_whatsapp`],
      aloj_contacto_telefono: body[`b_${lang}_aloj_contacto_telefono`],
      aloj_contacto_email: body[`b_${lang}_aloj_contacto_email`],
      resena_url: body[`b_${lang}_resena_url`]
    };
    const r = validateAlojamientoInput(sub, { secret, existingWifi: existingWifi.get(lang) || null });
    if (r.errors.length) errors.push(...r.errors.map((e) => `[${LANGUAGE_NAMES[lang] || lang}] ${e}`));
    perLang.set(lang, r.blocks);
  }
  const alojIdioma = LANGUAGES.includes(body.aloj_idioma) ? body.aloj_idioma : (tag ? tag.alojIdioma : 'es');
  return { errors, perLang, langs, alojIdioma };
}

// Guarda los bloques validados. Semántica «lo que ves es lo que guardas» por
// idioma: si el campo del bloque llegó en el formulario (presente en body)
// y quedó vacío, la fila de ese idioma se elimina; si trae contenido, se
// crea/actualiza. Los idiomas no marcados como presentes no se tocan.
function saveAlojamientoBlocks(models, tagId, langs, perLang, body) {
  const present = (lang, key, marker) =>
    body[`b_${lang}_${key}`] !== undefined ||
    (marker !== undefined && body[`b_${lang}_${marker}_present`] !== undefined);
  for (const lang of langs) {
    const blocks = perLang.get(lang) || {};
    const ensure = (type, presentFlag, content) => {
      if (!presentFlag) return;
      if (content) models.upsertBlock(tagId, { blockType: type, language: lang, content, position: 0, isVisible: 1 });
      else models.deleteBlock(tagId, type, lang);
    };
    ensure('acceso', present(lang, 'acceso_texto'), blocks.acceso);
    ensure('wifi', present(lang, 'aloj_wifi_ssid'), blocks.wifi);
    ensure('normas', present(lang, 'normas_texto', 'normas'), blocks.normas);
    ensure('manual', present(lang, 'manual_texto', 'manual'), blocks.manual);
    ensure('recomendaciones', present(lang, 'recomendaciones_texto', 'recomendaciones'), blocks.recomendaciones);
    ensure(
      'contacto',
      present(lang, 'aloj_contacto_whatsapp') || present(lang, 'aloj_contacto_telefono') || present(lang, 'aloj_contacto_email'),
      blocks.contacto
    );
    ensure('resena', present(lang, 'resena_url'), blocks.resena);
  }
}

function parseId(value) {
  const n = parseInt(String(value), 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// Normaliza el UID de un chip NFC tal como lo informa Web NFC
// (serialNumber: hex con «:», p. ej. «04:A3:B2:C1:5B:6A:80»). Devuelve el UID
// mayúsculas sin separadores (p. ej. «04A3B2C15B6A80»), o false si es
// inválido, o null si va vacío (desvincular).
function normalizeNfcUid(value) {
  const raw = String(value == null ? '' : value).trim().toUpperCase();
  if (!raw) return null;
  const hex = raw.replace(/[^0-9A-F]/g, '');
  if (hex.length < 4 || hex.length > 32) return false;
  // Debe ser prácticamente todo hex: los separadores no cuentan, pero si queda
  // muy poco hex respecto al original es basura.
  if (hex.length < Math.ceil(raw.length / 2)) return false;
  return hex;
}

function validateTagInput(body, opts = {}) {
  body = body || {};
  const errors = [];

  const nombre = String(body.nombre || '').trim();
  if (!nombre) errors.push('El nombre es obligatorio.');
  else if (nombre.length > 120) errors.push('El nombre no puede superar los 120 caracteres.');

  const tipo = ['qr', 'nfc', 'ambos'].includes(body.tipo) ? body.tipo : '';
  if (!tipo) errors.push('Selecciona un tipo de soporte.');

  const modo = ['url', 'wifi', 'contacto', 'presentacion', 'alojamiento', 'desactivado'].includes(body.modo) ? body.modo : '';
  if (!modo) errors.push('Selecciona un modo de destino.');

  const estado = ['activo', 'pausado'].includes(body.estado) ? body.estado : 'activo';

  let urlDestino = null;
  if (modo === 'url') {
    urlDestino = String(body.url_destino || '').trim();
    if (!isHttpUrl(urlDestino)) {
      errors.push('En modo URL, introduce una dirección válida que empiece por http:// o https://.');
    }
  }

  let wifi = null;
  if (modo === 'wifi') {
    const ssid = String(body.wifi_ssid || '').trim();
    if (!ssid) errors.push('El SSID (nombre de la red) es obligatorio en modo WiFi.');
    else if (ssid.length > 64) errors.push('El SSID no puede superar los 64 caracteres.');

    const seguridad = ['WPA', 'WEP', 'nopass'].includes(body.wifi_seguridad) ? body.wifi_seguridad : '';
    if (!seguridad) errors.push('Selecciona el tipo de seguridad WiFi.');

    const password = String(body.wifi_password || '');
    const keepPassword = opts.keepPassword && password === '';
    if (!keepPassword) {
      if (seguridad === 'WPA' && (password.length < 8 || password.length > 63)) {
        errors.push('La contraseña WPA/WPA2/WPA3 debe tener entre 8 y 63 caracteres.');
      }
      if (seguridad === 'WEP' && (password.length < 5 || password.length > 26)) {
        errors.push('La contraseña WEP debe tener entre 5 y 26 caracteres.');
      }
    }
    wifi = { ssid, seguridad, password, keepPassword };
  }

  let contacto = null;
  // Modo Contacto: al menos un dato obligatorio. Modo Presentación: opcionales
  // (la tarjeta puede ser solo foto + descripción), pero si se aportan deben
  // ser válidos.
  if (modo === 'contacto' || modo === 'presentacion') {
    const telefono = String(body.contacto_telefono || '').trim();
    const email = String(body.contacto_email || '').trim().toLowerCase();
    if (modo === 'contacto' && !telefono && !email) {
      errors.push('En modo Contacto, introduce al menos un teléfono o un correo electrónico.');
    }
    if (telefono && !/^\+?[0-9 ()\-./]{6,25}$/.test(telefono)) {
      errors.push('El teléfono no parece válido (usa solo dígitos, espacios, +, - o paréntesis).');
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      errors.push('El correo electrónico no parece válido.');
    }
    if (email && email.length > 120) {
      errors.push('El correo electrónico no puede superar los 120 caracteres.');
    }
    contacto = { telefono, email };
  }

  let presentacion = null;
  if (modo === 'presentacion') {
    const personaNombre = String(body.pres_persona_nombre || '').trim();
    if (!personaNombre) errors.push('En modo Presentación, el nombre de la persona es obligatorio.');
    else if (personaNombre.length > 80) errors.push('El nombre de la persona no puede superar los 80 caracteres.');

    const cargo = String(body.pres_cargo || '').trim();
    if (cargo.length > 80) errors.push('El cargo no puede superar los 80 caracteres.');

    const bio = String(body.pres_bio || '').trim();
    if (bio.length > 600) errors.push('La descripción no puede superar los 600 caracteres.');

    // La foto llega como data URL (JPEG ya redimensionado en el navegador).
    // Se valida formato y tamaño máximo (~300 KB tras la compresión cliente).
    const foto = String(body.pres_foto_data || '').trim();
    if (foto) {
      if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(foto)) {
        errors.push('La foto debe ser una imagen JPG o PNG válida.');
      } else if (foto.length > 400 * 1024) {
        errors.push('La foto es demasiado grande. Usa una imagen de menos de 300 KB.');
      }
    }
    const clearFoto = body.pres_foto_clear === '1';
    presentacion = { personaNombre, cargo, bio, foto, clearFoto };
  }

  let slug = String(body.slug || '').trim();
  if (slug && !isValidSlug(slug)) {
    errors.push('El slug solo puede contener letras, números, guiones o guiones bajos (3-64 caracteres).');
  }

  // Chip NFC: UID hexadecimal (el serial que lee el móvil, p. ej. NTAG213) y
  // modelo declarado. Opcional: vacío desvincula el chip de la ficha.
  const nfcUid = normalizeNfcUid(body.nfc_uid);
  if (nfcUid === false) {
    errors.push('El UID del chip NFC debe ser hexadecimal (se admiten separadores : o espacios), entre 4 y 32 dígitos.');
  }
  const nfcModelo = String(body.nfc_modelo || '').trim().toUpperCase().slice(0, 40) || null;

  return { errors, data: { nombre, tipo, modo, estado, urlDestino, wifi, contacto, presentacion, slug, nfcUid, nfcModelo } };
}

function createAdminRouter({ db, models, config, auth }) {
  const router = express.Router();

  router.use(auth.csrfProtect);
  router.use(auth.requireAuth);

  // Alojamientos: listado específico de propiedades turísticas (gestoras con
  // varias propiedades) con buscador y estadísticas por tag.
  router.get('/alojamientos', (req, res) => {
    const q = String(req.query.q || '').trim();
    const list = models.listTags({ q, modo: 'alojamiento', page: req.query.page });
    const vendidos = models.listTagsByModo('desactivado');
    res.render('admin/alojamientos', {
      title: 'Alojamientos',
      active: 'alojamientos',
      list,
      vendidos,
      pendientesVenta: vendidos.length,
      filters: { q }
    });
  });

  // Duplicar una propiedad (configuración idéntica a una nueva, para gestoras
  // con pisos similares).
  router.post('/tags/:id/duplicar', (req, res) => {
    const id = parseId(req.params.id);
    const tag = models.getTagById(id);
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });
    const nuevoNombre = String(req.body.nombre || '').trim();
    const nombre = nuevoNombre || `${tag.nombre} (copia)`;
    const copia = models.duplicateTag(id, nombre);
    if (!copia) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });
    req.session.flash = { type: 'success', msg: `Propiedad duplicada como «${copia.nombre}». Ajusta su contenido y comparte su nueva URL.` };
    res.redirect(`/admin/tags/${copia.id}`);
  });

  // Modo despedida: al final de la estancia, prioriza el bloque de reseña en
  // la página del huésped (manual: el anfitrión pulsa cuando quiera).
  router.post('/tags/:id/despedida', (req, res) => {
    const id = parseId(req.params.id);
    const tag = models.getTagById(id);
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });
    models.updateTag(id, { modoDespedida: !tag.modoDespedida });
    req.session.flash = {
      type: 'success',
      msg: !tag.modoDespedida
        ? 'Modo despedida activado: la página del huésped prioriza el enlace de reseña.'
        : 'Modo despedida desactivado: la página vuelve a la guía completa.'
    };
    res.redirect(`/admin/tags/${id}`);
  });

  // Listado con búsqueda y filtros
  router.get(['/', '/tags'], (req, res) => {
    const list = models.listTags({
      q: req.query.q,
      tipo: req.query.tipo,
      modo: req.query.modo,
      estado: req.query.estado,
      page: req.query.page
    });
    res.render('admin/dashboard', {
      title: 'Tags',
      active: 'tags',
      list,
      pendientes: models.countTagsByModo('desactivado'),
      filters: {
        q: req.query.q || '',
        tipo: req.query.tipo || '',
        modo: req.query.modo || '',
        estado: req.query.estado || ''
      }
    });
  });

  // Creación masiva de tags genéricos (stock para vender, aún sin configurar)
  // ---------- Identificación del chip NFC (p. ej. NTAG213) ----------

  // Página «Identificar chip»: leer el chip con el móvil (Web NFC) o escribir
  // su UID a mano, y asociarlo a una ficha existente.
  router.get('/nfc', (req, res) => {
    const porUid = models.listTagsByModo('desactivado').filter((t) => t.nfcUid);
    // Búsqueda manual por UID (?uid=…) desde el formulario de la página.
    const uidParam = normalizeNfcUid(req.query.uid);
    const prefillFound = uidParam && uidParam !== false ? { uid: uidParam, tag: models.getTagByNfcUid(uidParam) } : null;
    res.render('admin/nfc', {
      title: 'Identificar chip NFC',
      active: 'nfc',
      chips: porUid,
      pendientes: porUid.length,
      tags: models.listAllTags(),
      prefill: uidParam && uidParam !== false ? uidParam : String(req.query.uid || '').slice(0, 64),
      prefillFound
    });
  });

  // Guardar (o cambiar) la tarjeta asociada a un UID leído.
  router.post('/nfc', (req, res) => {
    const uid = normalizeNfcUid(req.body.uid);
    if (!uid || uid === false) {
      req.session.flash = { type: 'error', msg: 'UID no válido: acérca el chip al móvil o escríbelo en hexadecimal.' };
      return res.redirect('/admin/nfc');
    }
    const accion = String(req.body.accion || '');
    if (accion === 'desvincular') {
      const tag = models.getTagByNfcUid(uid);
      if (tag) {
        models.updateTag(tag.id, { nfcUid: null });
        req.session.flash = { type: 'success', msg: `Chip ${uid} desvinculado de «${tag.nombre}».` };
      } else {
        req.session.flash = { type: 'error', msg: `Ninguna ficha tiene el chip ${uid}.` };
      }
      return res.redirect('/admin/nfc');
    }
    const tagId = parseId(req.body.tag_id);
    const tag = models.getTagById(tagId);
    if (!tag) {
      req.session.flash = { type: 'error', msg: 'Selecciona la tarjeta que corresponde a ese chip.' };
      return res.redirect(`/admin/nfc?uid=${encodeURIComponent(uid)}`);
    }
    const otro = models.getTagByNfcUid(uid);
    if (otro && otro.id !== tag.id) {
      // Reasignación explícita: el chip pasa a la ficha elegida.
      models.updateTag(otro.id, { nfcUid: null });
    }
    models.updateTag(tag.id, { nfcUid: uid, nfcModelo: String(req.body.modelo || '').trim().toUpperCase().slice(0, 40) || (tag.nfcModelo || 'NTAG213') });
    req.session.flash = { type: 'success', msg: `Chip ${uid} guardado en «${tag.nombre}». Ya puedes configurarlo sabiendo exactamente qué tarjeta es.` };
    res.redirect(`/admin/tags/${tag.id}`);
  });

  // API JSON para la lectura en vivo con Web NFC: comprueba si el UID leído
  // ya pertenece a una ficha y devuelve su nombre (o null = chip nuevo).
  router.get('/nfc/buscar.json', (req, res) => {
    const uid = normalizeNfcUid(req.query.uid);
    if (!uid || uid === false) return res.json({ found: false, uid: null });
    const tag = models.getTagByNfcUid(uid);
    if (tag) return res.json({ found: true, uid, tagId: tag.id, nombre: tag.nombre, slug: tag.slug, modo: tag.modo, estado: tag.estado });
    res.json({ found: false, uid });
  });

  // Contraseñas WiFi guardadas (descifradas) para rellenar el formulario con
  // un clic: la del modo WiFi simple y las de los bloques WiFi de cada
  // idioma del alojamiento. Requiere sesión; nunca van a logs ni a la página
  // pública (allí solo viajan dentro del botón de conexión automática).
  router.get('/tags/:id/passwords.json', (req, res) => {
    const tag = models.getTagById(parseId(req.params.id));
    if (!tag) return res.status(404).json({ error: 'Tag no encontrado' });
    const out = { wifi: models.decryptWifiPassword(tag), aloj: {} };
    for (const row of models.listBlocks(tag.id)) {
      if (row.block_type !== 'wifi') continue;
      try {
        const content = JSON.parse(row.content);
        if (content.password_enc) out.aloj[row.language] = decryptText(content.password_enc, config.wifiSecret);
      } catch { /* bloque corrupto: se ignora */ }
    }
    res.json(out);
  });

  router.get('/tags/masivo', (req, res) => {
    res.render('admin/bulk', {
      title: 'Generar Tags en lote',
      active: 'bulk',
      errors: [],
      values: {}
    });
  });

  router.post('/tags/masivo', (req, res) => {
    const cantidad = parseInt(String(req.body.cantidad || '').trim(), 10);
    const prefijo = String(req.body.prefijo || 'Tag').trim();
    const tipo = ['qr', 'nfc', 'ambos'].includes(req.body.tipo) ? req.body.tipo : 'ambos';
    const errors = [];

    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 500) {
      errors.push('Introduce una cantidad entre 1 y 500.');
    }
    if (!prefijo) errors.push('El prefijo del nombre es obligatorio.');
    else if (prefijo.length > 60) errors.push('El prefijo no puede superar los 60 caracteres.');
    if (errors.length) {
      return res.status(400).render('admin/bulk', {
        title: 'Generar Tags en lote',
        active: 'bulk',
        errors,
        values: req.body || {}
      });
    }

    const creados = models.createBulkTags({ cantidad, prefijo, tipo });
    req.session.flash = {
      type: 'success',
      msg: `${creados} ${creados === 1 ? 'tag genérico creado' : 'tags genéricos creados'} en modo desactivado.`
    };
    res.redirect('/admin/tags?modo=desactivado');
  });

  // Descarga en ZIP de los QR de todos los tags sin configurar (stock pendiente)
  router.get('/tags/qr-pendientes.zip', wrap(async (req, res) => {
    const pendientes = models.listTagsByModo('desactivado');
    if (pendientes.length === 0) {
      req.session.flash = { type: 'error', msg: 'No hay Tags sin configurar para descargar.' };
      return res.redirect('/admin/tags');
    }

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="qr-pendientes.zip"');

    const zip = archiver('zip', { zlib: { level: 9 } });
    zip.pipe(res);
    for (const tag of pendientes) {
      const png = await qrPng(tagPublicUrl(publicBaseUrl(req, config), tag.slug));
      const nombreLimpio = tag.nombre.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      zip.append(png, { name: `${nombreLimpio}-${tag.slug}.png` });
    }
    await zip.finalize();
  }));

  // Copia de seguridad: página, descarga del snapshot y restauración
  router.get('/backup', (req, res) => {
    const stats = {
      tags: db.prepare('SELECT COUNT(*) AS c FROM tags').get().c,
      scans: db.prepare('SELECT COUNT(*) AS c FROM scans').get().c,
      pendientes: models.countTagsByModo('desactivado')
    };
    res.render('admin/backup', { title: 'Copia de seguridad', active: 'backup', stats });
  });

  // Descarga la base de datos completa como fichero .db (snapshot consistente)
  router.get('/backup/descargar', wrap(async (req, res) => {
    const tmp = tempPath('tagflow-backup');
    try {
      backupToFile(db, tmp);
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\.\d{3}Z$/, '');
      res.download(tmp, `tagflow-backup-${stamp}.db`, () => {
        try { fs.unlinkSync(tmp); } catch (_) { /* noop */ }
      });
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) { /* noop */ }
      throw err;
    }
  }));

  // Restaura los datos desde una copia subida (cuerpo crudo: application/octet-stream)
  router.post('/backup/restaurar', express.raw({ type: () => true, limit: '100mb' }), wrap(async (req, res) => {
    const body = req.body;
    if (!isValidSqliteBuffer(body)) {
      return res.status(400).json({ ok: false, error: 'El fichero no es una base de datos SQLite válida.' });
    }
    const tmp = tempPath('tagflow-restore');
    fs.writeFileSync(tmp, body);
    try {
      const summary = restoreFromFile(db, tmp);
      const restartHint = process.env.WIFI_SECRET || process.env.SESSION_SECRET
        ? ''
        : ' Si esta copia procede de otro equipo, reinicia la app una vez para recargar las claves de cifrado.';
      req.session.flash = {
        type: 'success',
        msg: `Copia restaurada: ${summary.tags} ${summary.tags === 1 ? 'tag' : 'tags'} y ${summary.scans} ${summary.scans === 1 ? 'escaneo' : 'escaneos'}.${restartHint}`
      };
      res.json({ ok: true, summary });
    } catch (err) {
      const error = err.code === 'NOT_TAGFLOW'
        ? err.message
        : `No se pudo restaurar la copia: ${err.message}`;
      res.status(400).json({ ok: false, error });
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* noop */ }
    }
  }));

  // Crear
  router.get('/tags/nuevo', (req, res) => {
    const preselectModo = ['url', 'wifi', 'contacto', 'presentacion', 'alojamiento', 'desactivado'].includes(req.query.modo)
      ? req.query.modo
      : null;
    res.render('admin/form', {
      title: 'Nuevo Tag',
      active: 'new',
      tag: null,
      errors: [],
      values: {},
      preselectModo,
      slugPreview: 'tu-slug',
      blocksByLang: {}
    });
  });

  router.post('/tags', (req, res) => {
    const { errors, data } = validateTagInput(req.body);
    let perLang = null;
    let langs = [];
    let alojIdioma = null;
    if (data.modo === 'alojamiento' && errors.length === 0) {
      const col = collectAlojamiento(req.body, null, models, config.wifiSecret);
      errors.push(...col.errors);
      perLang = col.perLang;
      langs = col.langs;
      alojIdioma = col.alojIdioma;
    }
    if (errors.length) {
      return res.status(400).render('admin/form', {
        title: 'Nuevo Tag',
        active: 'new',
        tag: null,
        errors,
        values: req.body || {},
        preselectModo: null,
        slugPreview: 'tu-slug',
        blocksByLang: {}
      });
    }
    let tag;
    try {
      if (data.nfcUid && models.getTagByNfcUid(data.nfcUid)) {
        const otro = models.getTagByNfcUid(data.nfcUid);
        return res.status(400).render('admin/form', {
          title: 'Nuevo Tag',
          active: 'new',
          tag: null,
          errors: [`Ese chip NFC ya está asociado a «${otro.nombre}». Un chip físico solo puede pertenecer a una ficha.`],
          values: req.body || {},
          preselectModo: null,
          slugPreview: 'tu-slug',
          blocksByLang: {}
        });
      }
      tag = models.createTag(data);
    } catch (err) {
      if (err.code === 'SLUG_TAKEN') {
        return res.status(400).render('admin/form', {
          title: 'Nuevo Tag',
          active: 'new',
          tag: null,
          errors: ['Ese slug ya está en uso. Elige otro o déjalo vacío para generar uno automático.'],
          values: req.body || {},
          preselectModo: null,
          slugPreview: 'tu-slug',
          blocksByLang: {}
        });
      }
      throw err;
    }
    if (data.modo === 'alojamiento') {
      saveAlojamientoBlocks(models, tag.id, langs, perLang, req.body);
      models.updateTag(tag.id, { alojIdioma });
    }
    req.session.flash = { type: 'success', msg: `Tag «${tag.nombre}» creado correctamente.` };
    res.redirect(`/admin/tags/${tag.id}`);
  });

  // Detalle
  router.get('/tags/:id', (req, res) => {
    const tag = models.getTagById(parseId(req.params.id));
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });

    const base = publicBaseUrl(req, config);
    const publicUrl = tagPublicUrl(base, tag.slug);
    const wifiPayload = tag.modo === 'wifi'
      ? buildWifiString({ ssid: tag.wifiSsid, password: models.decryptWifiPassword(tag), security: tag.wifiSeguridad })
      : null;
    const contactoPayload = tag.modo === 'contacto'
      ? buildVCard({ nombre: tag.nombre, telefono: tag.contactoTelefono, email: tag.contactoEmail })
      : tag.modo === 'presentacion'
        ? buildVCard({
            nombre: tag.presPersonaNombre || tag.nombre,
            telefono: tag.contactoTelefono,
            email: tag.contactoEmail,
            cargo: tag.presCargo,
            bio: tag.presBio
          })
        : null;
    tag.wifiPassword = tag.modo === 'wifi' ? models.decryptWifiPassword(tag) : null;
    const scans = models.recentScans(tag.id, 10).map((s) => ({
      created_at: s.created_at,
      label: osLabel(detectOS(s.user_agent)),
      location: fmtLocation(s),
      mapsUrl: mapsUrl(s.lat, s.lon),
      note: s.geo_note
    }));

    res.render('admin/detail', {
      title: tag.nombre,
      active: 'tags',
      tag,
      publicUrl,
      wifiPayload,
      contactoPayload,
      scans,
      alojBlocks: models.listBlocks(tag.id),
      BLOCK_LABELS,
      series: buildScanSeries(models.scanTimestamps(tag.id)),
      origen: models.scanReferrerCounts(tag.id)
    });
  });

  // Datos de la gráfica de escaneos (JSON): las mismas series que la vista,
  // servidas aparte para recargar la gráfica sin refrescar la página.
  router.get('/tags/:id/scans.json', (req, res) => {
    const tag = models.getTagById(parseId(req.params.id));
    if (!tag) return res.status(404).json({ error: 'Tag no encontrado' });
    res.json({
      series: buildScanSeries(models.scanTimestamps(tag.id)),
      origen: models.scanReferrerCounts(tag.id),
      total: tag.escaneos
    });
  });

  // Editar (con ?modo=... se preselecciona ese modo: flujo «configurar al vender»)
  router.get('/tags/:id/editar', (req, res) => {
    let tag = models.getTagById(parseId(req.params.id));
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });
    const preselectModo = ['url', 'wifi', 'contacto', 'presentacion', 'alojamiento', 'desactivado'].includes(req.query.modo)
      ? req.query.modo
      : null;
    // Un chip recién leído (p. ej. desde «Identificar chip») llega aquí para
    // quedar grabado en la ficha.
    const uidParam = normalizeNfcUid(req.query.uid);
    if (uidParam && uidParam !== false && !tag.nfcUid) {
      models.updateTag(tag.id, { nfcUid: uidParam, nfcModelo: tag.nfcModelo || 'NTAG213' });
      tag = models.getTagById(tag.id);
      req.session.flash = { type: 'success', msg: `Chip ${uidParam} vinculado a esta tarjeta.` };
    }
    // Bloques de alojamiento agrupados por idioma (para las pestañas del formulario).
    res.render('admin/form', {
      title: 'Editar Tag',
      active: 'tags',
      tag,
      errors: [],
      values: null,
      preselectModo,
      slugPreview: tag.slug,
      blocksByLang: blocksByLangFor(models, tag)
    });
  });

  router.post('/tags/:id', (req, res) => {
    const id = parseId(req.params.id);
    const tag = models.getTagById(id);
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });

    // Una contraseña en blanco solo es válida si el tag ya tenía una guardada.
    const { errors, data } = validateTagInput(req.body, { keepPassword: Boolean(tag.wifiPasswordEnc) });
    let perLang = null;
    let langs = [];
    let alojIdioma = null;
    if (data.modo === 'alojamiento' && errors.length === 0) {
      const col = collectAlojamiento(req.body, tag, models, config.wifiSecret);
      errors.push(...col.errors);
      perLang = col.perLang;
      langs = col.langs;
      alojIdioma = col.alojIdioma;
    }
    if (errors.length) {
      return res.status(400).render('admin/form', {
        title: 'Editar Tag',
        active: 'tags',
        tag,
        errors,
        values: req.body || {},
        preselectModo: null,
        slugPreview: tag.slug,
        blocksByLang: blocksByLangFor(tag)
      });
    }

    if (data.nfcUid) {
      const otro = models.getTagByNfcUid(data.nfcUid);
      if (otro && otro.id !== id) {
        return res.status(400).render('admin/form', {
          title: 'Editar Tag',
          active: 'tags',
          tag,
          errors: [`Ese chip NFC ya está asociado a «${otro.nombre}». Un chip físico solo puede pertenecer a una ficha.`],
          values: req.body || {},
          preselectModo: null,
          slugPreview: tag.slug,
          blocksByLang: blocksByLangFor(tag)
        });
      }
    }

    models.updateTag(id, {
      nombre: data.nombre,
      tipo: data.tipo,
      modo: data.modo,
      estado: data.estado,
      nfcUid: data.nfcUid || null,
      nfcModelo: data.nfcModelo,
      urlDestino: data.modo === 'url' ? data.urlDestino : undefined,
      clearUrl: data.modo !== 'url',
      wifi: data.modo === 'wifi' ? data.wifi : undefined,
      clearWifi: data.modo !== 'wifi',
      // El contacto se comparte entre los modos Contacto y Presentación.
      contacto: data.modo === 'contacto' || data.modo === 'presentacion' ? data.contacto : undefined,
      clearContacto: data.modo !== 'contacto' && data.modo !== 'presentacion',
      presentacion: buildPresentacionUpdate(data, tag),
      clearPresentacion: data.modo !== 'presentacion'
    });
    if (data.modo === 'alojamiento') {
      saveAlojamientoBlocks(models, id, langs, perLang, req.body);
      models.updateTag(id, { alojIdioma });
    } else {
      models.deleteBlocksByTag(id);
    }
    req.session.flash = { type: 'success', msg: 'Tag actualizado correctamente.' };
    res.redirect(`/admin/tags/${id}`);
  });

  // Eliminar
  router.post('/tags/:id/eliminar', (req, res) => {
    const id = parseId(req.params.id);
    const tag = models.getTagById(id);
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });
    models.deleteTag(id);
    req.session.flash = { type: 'success', msg: `Tag «${tag.nombre}» eliminado.` };
    res.redirect('/admin/tags');
  });

  // Cambiar estado (activo / pausado)
  router.post('/tags/:id/estado', (req, res) => {
    const id = parseId(req.params.id);
    const tag = models.getTagById(id);
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });
    const nuevo = tag.estado === 'activo' ? 'pausado' : 'activo';
    models.setEstado(id, nuevo);
    req.session.flash = { type: 'success', msg: `Tag «${tag.nombre}» ${nuevo === 'activo' ? 'activado' : 'pausado'}.` };
    let ref = req.get('referer') || '';
    try {
      const u = new URL(ref);
      ref = u.pathname + u.search;
    } catch {
      ref = '';
    }
    res.redirect(ref.startsWith('/admin') ? ref : `/admin/tags/${id}`);
  });

  // Entrada validada → parche para models.updateTag. Reglas de la foto:
  // foto nueva (data URL) la sustituye; «Quitar» la limpia; si no se toca,
  // se conserva la que hubiera (keepFoto).
  function buildPresentacionUpdate(data, currentTag) {
    if (data.modo !== 'presentacion') return undefined;
    const p = data.presentacion || {};
    const base = {
      personaNombre: p.personaNombre,
      cargo: p.cargo,
      bio: p.bio
    };
    if (p.clearFoto) return { ...base, foto: null, keepFoto: false };
    if (p.foto) return { ...base, foto: p.foto, keepFoto: false };
    return { ...base, keepFoto: Boolean(currentTag.presFoto) };
  }

  function qrPayload(tag, req, kind) {
    if (kind === 'wifi' && tag.modo === 'wifi') {
      return buildWifiString({
        ssid: tag.wifiSsid,
        password: models.decryptWifiPassword(tag),
        security: tag.wifiSeguridad
      });
    }
    if (kind === 'contacto' && tag.modo === 'contacto') {
      return buildVCard({ nombre: tag.nombre, telefono: tag.contactoTelefono, email: tag.contactoEmail });
    }
    if (kind === 'contacto' && tag.modo === 'presentacion') {
      return buildVCard({
        nombre: tag.presPersonaNombre || tag.nombre,
        telefono: tag.contactoTelefono,
        email: tag.contactoEmail,
        cargo: tag.presCargo,
        bio: tag.presBio
      });
    }
    return tagPublicUrl(publicBaseUrl(req, config), tag.slug);
  }

  // Descarga del QR en PNG (alta resolución)
  router.get('/tags/:id/qr.png', wrap(async (req, res) => {
    const tag = models.getTagById(parseId(req.params.id));
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });
    const kind = req.query.payload === 'wifi' ? 'wifi' : req.query.payload === 'contacto' ? 'contacto' : 'url';
    if (kind === 'wifi' && tag.modo !== 'wifi') {
      return res.status(400).render('admin/error', {
        status: 400,
        message: 'El payload WiFi solo está disponible cuando el Tag está en modo WiFi.'
      });
    }
    if (kind === 'contacto' && tag.modo !== 'contacto' && tag.modo !== 'presentacion') {
      return res.status(400).render('admin/error', {
        status: 400,
        message: 'El payload de contacto solo está disponible cuando el Tag está en modo Contacto o Presentación.'
      });
    }
    const png = await qrPng(qrPayload(tag, req, kind));
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename="qr-${tag.slug}.png"`);
    res.send(png);
  }));

  // Descarga del QR en SVG (vectorial)
  router.get('/tags/:id/qr.svg', wrap(async (req, res) => {
    const tag = models.getTagById(parseId(req.params.id));
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });
    const kind = req.query.payload === 'wifi' ? 'wifi' : req.query.payload === 'contacto' ? 'contacto' : 'url';
    if (kind === 'wifi' && tag.modo !== 'wifi') {
      return res.status(400).render('admin/error', {
        status: 400,
        message: 'El payload WiFi solo está disponible cuando el Tag está en modo WiFi.'
      });
    }
    if (kind === 'contacto' && tag.modo !== 'contacto' && tag.modo !== 'presentacion') {
      return res.status(400).render('admin/error', {
        status: 400,
        message: 'El payload de contacto solo está disponible cuando el Tag está en modo Contacto o Presentación.'
      });
    }
    const svg = await qrSvg(qrPayload(tag, req, kind));
    res.set('Content-Type', 'image/svg+xml');
    res.set('Content-Disposition', `attachment; filename="qr-${tag.slug}.svg"`);
    res.send(svg);
  }));

  // Descarga de la foto de presentación recortada en círculo: SVG vectorial
  // con la imagen incrustada y clip circular (fondo transparente, nitidez a
  // cualquier tamaño, sin dependencias nativas).
  router.get('/tags/:id/foto.png', (req, res) => {
    const tag = models.getTagById(parseId(req.params.id));
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });
    if (tag.modo !== 'presentacion' || !tag.presFoto) {
      return res.status(404).render('admin/error', { status: 404, message: 'Este Tag no tiene foto de presentación.' });
    }
    const svg = circularSvg(tag.presFoto);
    if (!svg) {
      return res.status(400).render('admin/error', { status: 400, message: 'La foto guardada no es una imagen válida.' });
    }
    res.set('Content-Type', 'image/svg+xml');
    res.set('Content-Disposition', `attachment; filename="foto-${tag.slug}.svg"`);
    res.send(svg);
  });

  return router;
}

module.exports = { createAdminRouter, validateTagInput, normalizeNfcUid };