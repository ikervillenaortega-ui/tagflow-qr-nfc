(function () {
  'use strict';

  var body = document.body;
  var os = body.dataset.os || 'other';
  var ssid = body.dataset.ssid || '';
  var hasPw = body.dataset.hasPw === 'true';

  // ===== Alojamiento: conexión WiFi automática desde la página del huésped =====
  var wifiBlock = document.querySelector('[data-wifi-block]');
  if (wifiBlock && wifiBlock.dataset.wifi) {
    var wifiData = null;
    try { wifiData = JSON.parse(wifiBlock.dataset.wifi); } catch (e) { wifiData = null; }
    var wConnect = wifiBlock.querySelector('[data-wifi-connect]');
    var wMsg = wifiBlock.querySelector('[data-wifi-msg]');
    var cred = null;
    if (wifiData) {
      cred = { type: wifiData.security === 'nopass' ? 'open' : (wifiData.security === 'WEP' ? 'wep' : 'wpa2'), ssid: wifiData.ssid };
      if (wifiData.security !== 'nopass' && wifiData.password) cred.password = wifiData.password;
    }
    var wm = navigator.wifi;
    var canConnect = cred && wm && typeof wm.getCcms === 'function' && typeof wm.addCcm === 'function';
    if (canConnect && wConnect && wMsg) {
      wConnect.hidden = false;
      wConnect.addEventListener('click', function () {
        wMsg.textContent = 'Abriendo la conexión…';
        wMsg.className = 'wifi-msg busy';
        wm.getCcms().then(function (list) {
          var existing = null;
          for (var i = 0; list && i < list.length; i++) {
            if (list[i] && list[i].ssid === cred.ssid) existing = list[i];
          }
          var op = existing ? wm.addCcm(cred, existing.id) : wm.addCcm(cred);
          return Promise.resolve(op).then(function () {
            wMsg.textContent = '✓ Red guardada. Si no te has conectado ya, elígela en Ajustes → WiFi.';
            wMsg.className = 'wifi-msg ok';
          });
        }).catch(function (err) {
          if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
            wMsg.textContent = 'Conexión cancelada. Da permiso al navegador y vuelve a intentarlo.';
            wMsg.className = 'wifi-msg err';
          } else {
            wMsg.textContent = 'No se pudo completar la conexión: sigue los pasos de abajo.';
            wMsg.className = 'wifi-msg err';
          }
        });
      });
    }
  }

  // Instrucciones adaptadas al sistema operativo detectado.
  var steps = document.getElementById('steps');
  if (steps) {
    var html;
    if (os === 'android') {
      html = '<h2>Cómo conectarte (Android)</h2><ol>' +
        '<li>Pulsa <strong>📲 Conectar a la red</strong> y confirma en la ventana que abre tu móvil.</li>' +
        '<li>Si tu móvil no lo soporta: abre <strong>Ajustes → WiFi</strong>.</li>' +
        '<li>Selecciona la red <strong>' + esc(ssid) + '</strong> y pega la contraseña.</li></ol>';
    } else if (os === 'ios') {
      html = '<h2>Cómo conectarte (iPhone / iPad)</h2><ol>' +
        '<li>Abre <strong>Ajustes → WiFi</strong>.</li>' +
        '<li>Selecciona la red <strong>' + esc(ssid) + '</strong>.</li>' +
        '<li>Pulsa «Copiar» arriba y pega la contraseña.</li></ol>';
    } else {
      html = '<h2>Cómo conectarte</h2><ol>' +
        '<li>Abre los ajustes de WiFi de tu dispositivo.</li>' +
        '<li>Selecciona la red <strong>' + esc(ssid) + '</strong>.</li>' +
        '<li>Introduce la contraseña que se muestra arriba.</li></ol>';
    }
    steps.innerHTML = html;
  }

  // Conexión directa (Android + Chrome): la Credential Management API abre el
  // diálogo nativo del sistema para unirse a la red, igual que al escanear un
  // QR de WiFi con la cámara. En otros sistemas el botón no se muestra.
  var connectArea = document.getElementById('connect-area');
  var connectBtn = document.getElementById('connect-btn');
  var connectMsg = document.getElementById('connect-msg');
  if (connectArea && connectBtn && connectMsg && os === 'android') {
    var cred = null;
    try { cred = JSON.parse(body.dataset.cred || 'null'); } catch (e) { cred = null; }
    var wm = navigator.wifi;
    var canConnect = cred && wm && typeof wm.getCcms === 'function' && typeof wm.addCcm === 'function';
    if (canConnect) {
      connectArea.hidden = false;
      connectBtn.addEventListener('click', function () {
        setMsg('Abriendo la conexión…', 'busy');
        wm.getCcms().then(function (list) {
          var i, existing = null;
          for (i = 0; list && i < list.length; i++) {
            if (list[i] && list[i].ssid === cred.ssid) existing = list[i];
          }
          var op = existing ? wm.addCcm(cred, existing.id) : wm.addCcm(cred);
          return Promise.resolve(op).then(function () {
            setMsg('✓ Red guardada. Si no te has conectado ya, elígela en Ajustes → WiFi.', 'ok');
          });
        }).catch(function (err) {
          if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
            setMsg('Conexión cancelada. Comprueba que has dado permiso y vuelve a intentarlo.', 'err');
          } else if (err && err.name === 'NotSupportedError') {
            setMsg('Este móvil no soporta la conexión directa. Sigue los pasos de abajo.', 'err');
          } else {
            setMsg('No se pudo completar la conexión. Sigue los pasos de abajo.', 'err');
          }
        });
      });
    }
  }

  function setMsg(text, cls) {
    connectMsg.textContent = text;
    connectMsg.className = 'connect-msg' + (cls ? ' ' + cls : '');
  }

  // Copiar la contraseña al portapapeles.
  var copyBtn = document.getElementById('copy-btn');
  var pw = document.getElementById('pw');
  var copied = document.getElementById('copied');
  if (copyBtn && pw && hasPw) {
    copyBtn.addEventListener('click', function () {
      copyText(pw.value, copyBtn, copied);
    });
  }

  // Copiar un valor (p. ej. teléfono o correo en la página de contacto).
  document.querySelectorAll('[data-copy-val]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      copyText(btn.dataset.copyVal, btn, null);
    });
  });

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function copyText(text, btn, okEl) {
    var origLabel = btn.textContent;
    var done = function () {
      if (okEl) okEl.style.display = 'block';
      btn.textContent = '✓ Copiado';
      setTimeout(function () {
        btn.textContent = origLabel;
        if (okEl) okEl.style.display = 'none';
      }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* sin soporte */ }
    document.body.removeChild(ta);
  }
})();