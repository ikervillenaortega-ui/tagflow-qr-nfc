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

// Credencial JSON para la API Credential Management de Android (Chrome): al
// pulsar «Conectar a la red», el sistema operativo abre su diálogo nativo de
// conexión y el usuario entra en la red sin tocar Ajustes. Es el mismo mecanismo
// que usa Android al leer un QR con la cámara, servido aquí desde la web.
// Sólo WPA/WEP admiten contraseña; para redes abiertas se omite el campo.
function buildAndroidWifiCredential({ ssid, password = '', security = 'WPA' }) {
  const sec = SECURITIES.includes(security) ? security : 'WPA';
  const type = sec === 'nopass' ? 'open' : sec === 'WEP' ? 'wep' : 'wpa2';
  const cred = { type, ssid };
  if (sec !== 'nopass' && password) cred.password = password;
  return cred;
}

module.exports = { buildWifiString, buildAndroidWifiCredential, escapeWifiValue, SECURITIES };