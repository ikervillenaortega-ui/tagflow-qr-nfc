(function () {
  'use strict';

  var body = document.body;
  var os = body.dataset.os || 'other';
  var ssid = body.dataset.ssid || '';
  var hasPw = body.dataset.hasPw === 'true';

  // ===== Conexión WiFi automática desde la página del huésped =====
  // La contraseña NUNCA viaja en el HTML: se pide al servidor solo cuando el
  // huésped pulsa «Conectarme a la red», y únicamente si el navegador soporta
  // la conexión directa (Android/Chrome con la Network API).
  var wifiBlock = document.querySelector('[data-wifi-block]');
  var connectArea = document.getElementById('connect-area');
  var slug = (wifiBlock && wifiBlock.dataset.tagSlug) || body.dataset.tagSlug || '';
  var wifiConnectBtn = (wifiBlock && wifiBlock.querySelector('[data-wifi-connect]')) || (connectArea && connectArea.querySelector('#connect-btn'));
  var wifiMsgEl = (wifiBlock && wifiBlock.querySelector('[data-wifi-msg]')) || (connectArea && connectArea.querySelector('#connect-msg'));
  if (wifiConnectBtn && slug) {
    var wm = navigator.wifi;
    var canConnect = wm && typeof wm.getCcms === 'function' && typeof wm.addCcm === 'function';
    if (canConnect) {
      wifiConnectBtn.hidden = false;
      wifiConnectBtn.addEventListener('click', function () {
        if (wifiMsgEl) {
          wifiMsgEl.textContent = 'Abriendo la conexión…';
          wifiMsgEl.className = wifiBlock ? 'wifi-msg busy' : 'connect-msg busy';
        }
        fetch('/t/' + encodeURIComponent(slug) + '/credencial.json', { credentials: 'omit' })
          .then(function (r) { if (!r.ok) throw new Error('sin credencial'); return r.json(); })
          .then(function (cred) {
            if (!cred || !cred.ssid) throw new Error('sin credencial');
            return wm.getCcms().then(function (list) {
              var existing = null;
              for (var i = 0; list && i < list.length; i++) {
                if (list[i] && list[i].ssid === cred.ssid) existing = list[i];
              }
              var op = existing ? wm.addCcm(cred, existing.id) : wm.addCcm(cred);
              return Promise.resolve(op);
            });
          })
          .then(function () {
            if (wifiMsgEl) {
              wifiMsgEl.textContent = '✓ Red guardada. Si no te has conectado ya, elígela en Ajustes → WiFi.';
              wifiMsgEl.className = wifiBlock ? 'wifi-msg ok' : 'connect-msg ok';
            }
          })
          .catch(function (err) {
            if (wifiMsgEl) {
              if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
                wifiMsgEl.textContent = 'Conexión cancelada. Da permiso al navegador y vuelve a intentarlo.';
              } else {
                wifiMsgEl.textContent = 'No se pudo completar la conexión: sigue los pasos de abajo.';
              }
              wifiMsgEl.className = wifiBlock ? 'wifi-msg err' : 'connect-msg err';
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