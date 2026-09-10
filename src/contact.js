'use strict';

// Datos de contacto (modo Contacto): genera el payload vCard 3.0 usado tanto
// para el QR «Contacto directo» como para escribir en la etiqueta NFC.
// La mayoría de cámaras (iOS y Android) reconocen una vCard y ofrecen
// «Guardar contacto»; las apps NFC escriben la vCard como registro de texto.

// Escapa los caracteres reservados de vCard (\\ ; , y saltos de línea).
function escapeVCardValue(value) {
  return String(value || '').replace(/([\\;,])/g, '\\$1').replace(/\r?\n/g, '\\n');
}

// Construye una vCard 3.0 con nombre + teléfono y/o correo. En modo Presentación
// se añade el cargo (TITLE) y la descripción (NOTE) para que el contacto guardado
// en el móvil lleve también esos datos.
function buildVCard({ nombre, telefono, email, cargo, bio }) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  if (nombre) lines.push(`FN:${escapeVCardValue(nombre)}`);
  if (cargo) lines.push(`TITLE:${escapeVCardValue(cargo)}`);
  if (telefono) lines.push(`TEL;TYPE=CELL:${String(telefono).replace(/[^\d+]/g, '')}`);
  if (email) lines.push(`EMAIL:${String(email).trim()}`);
  if (bio) lines.push(`NOTE:${escapeVCardValue(bio)}`);
  lines.push('END:VCARD');
  return lines.join('\n');
}

module.exports = { buildVCard, escapeVCardValue };