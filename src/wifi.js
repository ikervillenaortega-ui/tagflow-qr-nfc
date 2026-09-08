'use strict';

const SECURITIES = ['WPA', 'WEP', 'nopass'];

// Escapa los caracteres reservados del formato WIFI: (\ ; , : ")
function escapeWifiValue(value) {
  return String(value).replace(/([\\;,:"])/g, '\\$1');
}

// Genera el string estándar WIFI: reconocido de forma nativa por las
// cámaras de Android y por las apps de lectura de códigos QR.
// Ejemplos:
//   WIFI:T:WPA;S:MiRed;P:clave1234;;
//   WIFI:T:nopass;S:Café;;
function buildWifiString({ ssid, password = '', security = 'WPA' }) {
  const sec = SECURITIES.includes(security) ? security : 'WPA';
  let out = `WIFI:T:${sec};S:${escapeWifiValue(ssid)};`;
  if (sec !== 'nopass') out += `P:${escapeWifiValue(password)};`;
  return out + ';';
}

module.exports = { buildWifiString, escapeWifiValue, SECURITIES };