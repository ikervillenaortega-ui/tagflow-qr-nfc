'use strict';
const express = require('express');
const archiver = require('archiver');
const { publicBaseUrl, tagPublicUrl, detectOS, osLabel, isHttpUrl, fmtLocation, mapsUrl } = require('../helpers');
const { buildWifiString } = require('../wifi');
const { buildVCard } = require('../contact');
const { qrPng, qrSvg } = require('../qr');
const { isValidSlug } = require('../slugs');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseId(value) {
  const n = parseInt(String(value), 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function validateTagInput(body, opts = {}) {
  body = body || {};
  const errors = [];

  const nombre = String(body.nombre || '').trim();
  if (!nombre) errors.push('El nombre es obligatorio.');
  else if (nombre.length > 120) errors.push('El nombre no puede superar los 120 caracteres.');

  const tipo = ['qr', 'nfc', 'ambos'].includes(body.tipo) ? body.tipo : '';
  if (!tipo) errors.push('Selecciona un tipo de soporte.');

  const modo = ['url', 'wifi', 'contacto', 'desactivado'].includes(body.modo) ? body.modo : '';
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
  if (modo === 'contacto') {
    const telefono = String(body.contacto_telefono || '').trim();
    const email = String(body.contacto_email || '').trim().toLowerCase();
    if (!telefono && !email) {
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

  let slug = String(body.slug || '').trim();
  if (slug && !isValidSlug(slug)) {
    errors.push('El slug solo puede contener letras, números, guiones o guiones bajos (3-64 caracteres).');
  }

  return { errors, data: { nombre, tipo, modo, estado, urlDestino, wifi, contacto, slug } };
}

function createAdminRouter({ db, models, config, auth }) {
  const router = express.Router();

  router.use(auth.csrfProtect);
  router.use(auth.requireAuth);

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

  // Crear
  router.get('/tags/nuevo', (req, res) => {
    res.render('admin/form', {
      title: 'Nuevo Tag',
      active: 'new',
      tag: null,
      errors: [],
      values: {},
      slugPreview: 'tu-slug'
    });
  });

  router.post('/tags', (req, res) => {
    const { errors, data } = validateTagInput(req.body);
    if (errors.length) {
      return res.status(400).render('admin/form', {
        title: 'Nuevo Tag',
        active: 'new',
        tag: null,
        errors,
        values: req.body || {},
        slugPreview: 'tu-slug'
      });
    }
    let tag;
    try {
      tag = models.createTag(data);
    } catch (err) {
      if (err.code === 'SLUG_TAKEN') {
        return res.status(400).render('admin/form', {
          title: 'Nuevo Tag',
          active: 'new',
          tag: null,
          errors: ['Ese slug ya está en uso. Elige otro o déjalo vacío para generar uno automático.'],
          values: req.body || {},
          slugPreview: 'tu-slug'
        });
      }
      throw err;
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
      : null;
    tag.wifiPassword = tag.modo === 'wifi' ? models.decryptWifiPassword(tag) : null;
    const scans = models.recentScans(tag.id, 10).map((s) => ({
      created_at: s.created_at,
      label: osLabel(detectOS(s.user_agent)),
      location: fmtLocation(s),
      mapsUrl: mapsUrl(s.lat, s.lon),
      note: s.geo_note
    }));

    res.render('admin/detail', { title: tag.nombre, active: 'tags', tag, publicUrl, wifiPayload, contactoPayload, scans });
  });

  // Editar
  router.get('/tags/:id/editar', (req, res) => {
    const tag = models.getTagById(parseId(req.params.id));
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });
    res.render('admin/form', {
      title: 'Editar Tag',
      active: 'tags',
      tag,
      errors: [],
      values: null,
      slugPreview: tag.slug
    });
  });

  router.post('/tags/:id', (req, res) => {
    const id = parseId(req.params.id);
    const tag = models.getTagById(id);
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });

    // Una contraseña en blanco solo es válida si el tag ya tenía una guardada.
    const { errors, data } = validateTagInput(req.body, { keepPassword: Boolean(tag.wifiPasswordEnc) });
    if (errors.length) {
      return res.status(400).render('admin/form', {
        title: 'Editar Tag',
        active: 'tags',
        tag,
        errors,
        values: req.body || {},
        slugPreview: tag.slug
      });
    }

    models.updateTag(id, {
      nombre: data.nombre,
      tipo: data.tipo,
      modo: data.modo,
      estado: data.estado,
      urlDestino: data.modo === 'url' ? data.urlDestino : undefined,
      clearUrl: data.modo !== 'url',
      wifi: data.modo === 'wifi' ? data.wifi : undefined,
      clearWifi: data.modo !== 'wifi',
      contacto: data.modo === 'contacto' ? data.contacto : undefined,
      clearContacto: data.modo !== 'contacto'
    });
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
    if (kind === 'contacto' && tag.modo !== 'contacto') {
      return res.status(400).render('admin/error', {
        status: 400,
        message: 'El payload de contacto solo está disponible cuando el Tag está en modo Contacto.'
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
    if (kind === 'contacto' && tag.modo !== 'contacto') {
      return res.status(400).render('admin/error', {
        status: 400,
        message: 'El payload de contacto solo está disponible cuando el Tag está en modo Contacto.'
      });
    }
    const svg = await qrSvg(qrPayload(tag, req, kind));
    res.set('Content-Type', 'image/svg+xml');
    res.set('Content-Disposition', `attachment; filename="qr-${tag.slug}.svg"`);
    res.send(svg);
  }));

  return router;
}

module.exports = { createAdminRouter, validateTagInput };