(function () {
  'use strict';

  var body = document.body;
  var os = body.dataset.os || 'other';
  var ssid = body.dataset.ssid || '';
  var hasPw = body.dataset.hasPw === 'true';

  // Instrucciones adaptadas al sistema operativo detectado.
  var steps = document.getElementById('steps');
  if (steps) {
    var html;
    if (os === 'android') {
      html = '<h2>Cómo conectarte (Android)</h2><ol>' +
        '<li>Abre <strong>Ajustes → WiFi</strong>.</li>' +
        '<li>Selecciona la red <strong>' + esc(ssid) + '</strong>.</li>' +
        '<li>Pega la contraseña y pulsa <strong>Conectar</strong>.</li></ol>';
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
    var done = function () {
      if (okEl) okEl.style.display = 'block';
      btn.textContent = '✓ Copiado';
      setTimeout(function () {
        btn.textContent = 'Copiar';
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