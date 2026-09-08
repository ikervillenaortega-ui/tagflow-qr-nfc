'use strict';
const QRCode = require('qrcode');

// Genera un QR en PNG (alta resolución, listo para imprimir).
function qrPng(text, { scale = 12, margin = 4 } = {}) {
  return QRCode.toBuffer(String(text), {
    errorCorrectionLevel: 'M',
    scale,
    margin
  });
}

// Genera un QR en SVG (vectorial).
function qrSvg(text, { width = 512, margin = 4 } = {}) {
  return QRCode.toString(String(text), {
    errorCorrectionLevel: 'M',
    width,
    margin,
    type: 'svg'
  });
}

module.exports = { qrPng, qrSvg };