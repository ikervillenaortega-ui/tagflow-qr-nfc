'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createAuth({ db, models, config }) {
  // Limitación de intentos de login por IP (en memoria).
  const attempts = new Map();

  function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
      return res.redirect('/admin/login');
    }
    // Garantiza token CSRF para las páginas autenticadas.
    if (!req.session.csrf) req.session.csrf = randomToken();
    next();
  }

  // Protección CSRF para todos los métodos de escritura.
  function csrfProtect(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const token = req.body && req.body._csrf ? req.body._csrf : req.get('x-csrf-token');
    if (!req.session || !req.session.csrf || !safeEqual(token, req.session.csrf)) {
      return res.status(403).render('admin/error', {
        status: 403,
        message: 'Token de seguridad inválido o caducado. Vuelve a cargar la página e inténtalo de nuevo.'
      });
    }
    next();
  }

  const router = express.Router();
  router.use(csrfProtect);

  router.get('/login', (req, res) => {
    if (req.session && req.session.userId) return res.redirect('/admin/tags');
    if (!req.session.csrf) req.session.csrf = randomToken();
    res.render('admin/login', { error: null, csrfToken: req.session.csrf });
  });

  router.post('/login', (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    let entry = attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      attempts.set(ip, entry);
    }
    if (entry.count >= MAX_ATTEMPTS) {
      const waitMin = Math.max(1, Math.ceil((entry.resetAt - now) / 60000));
      return res.status(429).render('admin/login', {
        error: `Demasiados intentos fallidos. Inténtalo de nuevo en ${waitMin} min.`,
        csrfToken: req.session.csrf
      });
    }

    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const user = models.findUserByUsername(username);
    const ok = user && bcrypt.compareSync(password, user.password_hash);

    if (!ok) {
      entry.count += 1;
      return res.status(401).render('admin/login', {
        error: 'Usuario o contraseña incorrectos.',
        csrfToken: req.session.csrf
      });
    }

    attempts.delete(ip);
    // Regenera la sesión tras el login para evitar fijación de sesión.
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        return res.status(500).render('admin/login', {
          error: 'Error al iniciar sesión. Inténtalo de nuevo.',
          csrfToken: req.session.csrf
        });
      }
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.csrf = randomToken();
      res.redirect('/admin/tags');
    });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
  });

  return { router, requireAuth, csrfProtect, randomToken };
}

module.exports = { createAuth, randomToken };