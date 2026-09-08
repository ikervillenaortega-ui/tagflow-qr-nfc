'use strict';
const express = require('express');
const { detectOS, isHttpUrl } = require('../helpers');

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

    // Registro del escaneo (contador + detalle para estadísticas).
    models.recordScan(tag.id, req);

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
        os: detectOS(req.get('user-agent'))
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