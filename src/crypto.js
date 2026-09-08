'use strict';
const crypto = require('crypto');

// Cifrado simétrico AES-256-GCM para las contraseñas WiFi en reposo.
// La clave se deriva del secreto de configuración mediante SHA-256.

function makeKey(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptText(plaintext, secret) {
  const key = makeKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1.' + Buffer.concat([iv, tag, ct]).toString('base64url');
}

function decryptText(payload, secret) {
  const key = makeKey(secret);
  const parts = String(payload).split('.', 2);
  if (parts.length !== 2 || parts[0] !== 'v1') throw new Error('Formato de cifrado no soportado');
  const raw = Buffer.from(parts[1], 'base64url');
  if (raw.length < 28) throw new Error('Payload cifrado inválido');
  const iv = raw.slice(0, 12);
  const tag = raw.slice(12, 28);
  const ct = raw.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { encryptText, decryptText, makeKey };