'use strict';
const express = require('express');
const { detectOS, isHttpUrl, clientIp } = require('../helpers');
const { ipToLocation } = require('../geo');
const { buildAndroidWifiCredential } = require('../wifi');

function createPublicRouter({ db, models, config }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.render('public/home', { title: config.appName });
  });

  router.get('/healthz', (req, res) => {
    res.json({ ok: true, app: config.appName, time: new Date().toISOString() });
  });

  // Endpoint público: GET /t/{slug}
  router.get('/t/:slug', (req, res) => {
    const slug = String(req.params.slug);
    const tag = models.getTagBySlug(slug);

    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex');

    if (!tag) {
      return res.status(404).render('public/disabled', {
        title: 'Código no encontrado',
        message: 'Este código no existe o ya no está disponible.'
      });
    }

    // Registro del escaneo (contador + detalle para estadísticas). La ubicación
    // aproximada se resuelve por IP en segundo plano: no retrasa la respuesta y
    // si falla el escaneo queda igualmente registrado.
    const ip = clientIp(req);
    const scanId = models.recordScan(tag.id, req, ip);
    if (config.geoEnabled !== false) {
      ipToLocation(ip)
        .then(({ geo, note }) => models.updateScanLocation(scanId, geo, note))
        .catch(() => {});
    }

    if (tag.estado !== 'activo' || tag.modo === 'desactivado') {
      return res.render('public/disabled', {
        title: 'Código sin configurar',
        message: 'El propietario aún no ha asignado un destino a este código. Vuelve a intentarlo más tarde.'
      });
    }

    if (tag.modo === 'url') {
      // Redirección inmediata (302: el destino puede cambiar en cualquier momento).
      if (!isHttpUrl(tag.urlDestino)) {
        return res.render('public/disabled', {
          title: 'Código sin configurar',
          message: 'El destino de este código no es válido. Contacta con el propietario.'
        });
      }
      return res.redirect(302, tag.urlDestino);
    }

    if (tag.modo === 'wifi') {
      const wifi = {
        ssid: tag.wifiSsid,
        password: tag.wifiPasswordEnc ? models.decryptWifiPassword(tag) : '',
        seguridad: tag.wifiSeguridad || 'WPA'
      };
      return res.render('public/wifi', {
        title: `Conectarse a ${wifi.ssid}`,
        nombre: tag.nombre,
        wifi,
        androidCred: buildAndroidWifiCredential(wifi),
        os: detectOS(req.get('user-agent'))
      });
    }

    if (tag.modo === 'contacto') {
      const contacto = {
        telefono: tag.contactoTelefono || '',
        email: tag.contactoEmail || ''
      };
      return res.render('public/contact', {
        title: `Contacto · ${tag.nombre}`,
        nombre: tag.nombre,
        contacto
      });
    }

    return res.render('public/disabled', {
      title: 'Código sin configurar',
      message: 'El propietario aún no ha asignado un destino a este código. Vuelve a intentarlo más tarde.'
    });
  });

  return router;
}

module.exports = { createPublicRouter };