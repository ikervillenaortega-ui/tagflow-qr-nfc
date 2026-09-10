'use strict';

// Utilidades de imagen sin dependencias nativas. La foto de presentación se
// guarda como data URL (JPEG/PNG ya optimizado en el navegador); para la
// «foto circular descargable» se genera un SVG vectorial que incrusta la
// imagen y la recorta en círculo: fichero real con fondo transparente,
// nitidez perfecta a cualquier tamaño y sin necesidad de decodificar JPEG
// en el servidor.

const CIRCULAR_SVG_SIZE = 1024;

// Devuelve un SVG (string) que muestra la imagen recortada en círculo, o null
// si la data URL no es una imagen soportada (png/jpeg).
function circularSvg(dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const mime = m[1] === 'png' ? 'image/png' : 'image/jpeg';
  const b64 = m[2];
  const s = CIRCULAR_SVG_SIZE;
  const r = s / 2;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">`,
    `  <defs><clipPath id="c"><circle cx="${r}" cy="${r}" r="${r}"/></clipPath></defs>`,
    `  <image width="${s}" height="${s}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c)" xlink:href="data:${mime};base64,${b64}"/>`,
    `</svg>`
  ].join('\n');
}

module.exports = { circularSvg };
