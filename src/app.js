'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const { SqliteSessionStore } = require('./sessions');
const { createAuth } = require('./auth');
const { createPublicRouter } = require('./routes/public');
const { createAdminRouter } = require('./routes/admin');
const { createModels } = require('./models');
const { fmtDate, escapeHtml } = require('./helpers');

function createApp({ config, db }) {
  const models = createModels(db, config);
  const auth = createAuth({ db, models, config });
  // Versión de assets estáticos: cambia en cada arranque para invalidar la caché
  // del navegador (express.static envía max-age=1d, que en dev esconde cambios).
  const assetVersion = Date.now().toString(36);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  // Detrás de proxies encadenados (Render, Cloudflare, Nginx…) se confía en
  // todos los saltos para que req.ip sea la IP real del cliente.
  app.set('trust proxy', config.trustProxy ? true : false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          upgradeInsecureRequests: config.isProd ? [] : null
        }
      }
    })
  );

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.static(path.join(config.root, 'public'), { maxAge: '1d' }));

  app.use(
    session({
      store: new SqliteSessionStore(db, config.sessionTtlMs),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        maxAge: config.sessionTtlMs,
        path: '/'
      }
    })
  );

  // Variables disponibles en todas las vistas.
  app.use((req, res, next) => {
    res.locals.appName = config.appName;
    res.locals.v = assetVersion;
    res.locals.fmtDate = fmtDate;
    res.locals.escapeHtml = escapeHtml;
    res.locals.urlenc = (s) => encodeURIComponent(String(s));
    res.locals.currentUser = req.session && req.session.userId ? { username: req.session.username } : null;
    res.locals.csrfToken = req.session ? req.session.csrf : '';
    res.locals.flash = req.session && req.session.flash ? req.session.flash : null;
    if (req.session && req.session.flash) delete req.session.flash;
    next();
  });

  app.use('/', createPublicRouter({ db, models, config }));
  app.use('/admin', auth.router);
  app.use('/admin', createAdminRouter({ db, models, config, auth }));

  // Nota: appName se pasa explícitamente porque el manejador de errores también
  // captura fallos de middlewares previos (p. ej. la sesión), cuando res.locals
  // aún no se ha rellenado y admin/error no podría leer appName.
  app.use((req, res) => {
    res.status(404).render('admin/error', { status: 404, message: 'Página no encontrada.', appName: config.appName, v: assetVersion });
  });

  app.use((err, req, res, next) => {
    console.error('[error]', err);
    if (res.headersSent) return next(err);
    res.status(500).render('admin/error', { status: 500, message: 'Error interno del servidor.', appName: config.appName, v: assetVersion });
  });

  return app;
}

module.exports = { createApp };