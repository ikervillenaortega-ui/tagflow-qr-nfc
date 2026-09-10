'use strict';
const express = require('express');
const { detectOS, isHttpUrl, clientIp } = require('../helpers');
const { ipToLocation } = require('../geo');
const { buildAndroidWifiCredential } = require('../wifi');
const { buildVCard } = require('../contact');
const { buildGuestView } = require('../alojamiento');

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

    if (tag.modo === 'alojamiento') {
      const view = buildGuestView({
        blockRows: models.listBlocks(tag.id),
        acceptLanguage: req.get('accept-language'),
        defaultLanguage: tag.alojIdioma,
        secret: config.wifiSecret
      });
      return res.render('public/alojamiento', {
        title: `${tag.nombre} · Información de tu estancia`,
        nombre: tag.nombre,
        view,
        despedida: tag.modoDespedida,
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

    if (tag.modo === 'presentacion') {
      const contacto = {
        telefono: tag.contactoTelefono || '',
        email: tag.contactoEmail || ''
      };
      const persona = tag.presPersonaNombre || tag.nombre;
      return res.render('public/presentacion', {
        title: `${persona} · Presentación`,
        slug: tag.slug,
        appNameTag: config.appName,
        nombre: persona,
        cargo: tag.presCargo || '',
        bio: tag.presBio || '',
        foto: tag.presFoto || '',
        contacto
      });
    }

    return res.render('public/disabled', {
      title: 'Código sin configurar',
      message: 'El propietario aún no ha asignado un destino a este código. Vuelve a intentarlo más tarde.'
    });
  });

  // Descarga pública de la vCard (modo Contacto y modo Presentación): los
  // móviles la ofrecen como «guardar contacto» al abrirla.
  router.get('/t/:slug/contacto.vcf', (req, res) => {
    const slug = String(req.params.slug);
    const tag = models.getTagBySlug(slug);
    res.set('X-Robots-Tag', 'noindex');
    if (!tag || (tag.modo !== 'contacto' && tag.modo !== 'presentacion') || tag.estado !== 'activo') {
      return res.status(404).send('Tarjeta de contacto no disponible.');
    }
    const vcard = tag.modo === 'presentacion'
      ? buildVCard({
          nombre: tag.presPersonaNombre || tag.nombre,
          telefono: tag.contactoTelefono,
          email: tag.contactoEmail,
          cargo: tag.presCargo,
          bio: tag.presBio
        })
      : buildVCard({ nombre: tag.nombre, telefono: tag.contactoTelefono, email: tag.contactoEmail });
    res.set('Content-Type', 'text/vcard; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="contacto-${tag.slug}.vcf"`);
    res.send(vcard);
  });

  return router;
}

module.exports = { createPublicRouter };