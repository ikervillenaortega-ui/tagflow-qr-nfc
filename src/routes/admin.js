'use strict';
const express = require('express');
const { publicBaseUrl, tagPublicUrl, detectOS, osLabel, isHttpUrl } = require('../helpers');
const { buildWifiString } = require('../wifi');
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

  const modo = ['url', 'wifi', 'desactivado'].includes(body.modo) ? body.modo : '';
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

  let slug = String(body.slug || '').trim();
  if (slug && !isValidSlug(slug)) {
    errors.push('El slug solo puede contener letras, números, guiones o guiones bajos (3-64 caracteres).');
  }

  return { errors, data: { nombre, tipo, modo, estado, urlDestino, wifi, slug } };
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
      filters: {
        q: req.query.q || '',
        tipo: req.query.tipo || '',
        modo: req.query.modo || '',
        estado: req.query.estado || ''
      }
    });
  });

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
    tag.wifiPassword = tag.modo === 'wifi' ? models.decryptWifiPassword(tag) : null;
    const scans = models.recentScans(tag.id, 10).map((s) => ({
      created_at: s.created_at,
      label: osLabel(detectOS(s.user_agent))
    }));

    res.render('admin/detail', { title: tag.nombre, active: 'tags', tag, publicUrl, wifiPayload, scans });
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
      clearWifi: data.modo !== 'wifi'
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
    return tagPublicUrl(publicBaseUrl(req, config), tag.slug);
  }

  // Descarga del QR en PNG (alta resolución)
  router.get('/tags/:id/qr.png', wrap(async (req, res) => {
    const tag = models.getTagById(parseId(req.params.id));
    if (!tag) return res.status(404).render('admin/error', { status: 404, message: 'Tag no encontrado.' });
    const kind = req.query.payload === 'wifi' ? 'wifi' : 'url';
    if (kind === 'wifi' && tag.modo !== 'wifi') {
      return res.status(400).render('admin/error', {
        status: 400,
        message: 'El payload WiFi solo está disponible cuando el Tag está en modo WiFi.'
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
    const kind = req.query.payload === 'wifi' ? 'wifi' : 'url';
    if (kind === 'wifi' && tag.modo !== 'wifi') {
      return res.status(400).render('admin/error', {
        status: 400,
        message: 'El payload WiFi solo está disponible cuando el Tag está en modo WiFi.'
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