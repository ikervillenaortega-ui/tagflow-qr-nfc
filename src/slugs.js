'use strict';
const crypto = require('node:crypto');

// Alfabeto sin caracteres ambiguos (0, O, 1, l, I)
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;

// crypto.randomInt es uniforme (muestreo por rechazo interno) y seguro.
function generateSlug(length = 8) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

function isValidSlug(value) {
  return typeof value === 'string' && SLUG_RE.test(value);
}

module.exports = { generateSlug, isValidSlug, SLUG_RE };