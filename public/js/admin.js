(function () {
  'use strict';

  // Marca que JS está activo (permite ocultar campos condicionales vía CSS
  // sin romper el formulario si el navegador no tiene JavaScript).
  document.documentElement.classList.add('js');

  // Confirmación antes de eliminar
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });

  // Botones de copiar al portapapeles
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var el = document.querySelector(btn.dataset.copy);
      if (!el) return;
      copyText(el.textContent.trim(), btn);
    });
  });

  // Formulario de tag: mostrar/ocultar campos según el modo + preview WiFi
  var form = document.getElementById('tag-form');
  if (form) {
    var modoInputs = Array.prototype.filter.call(
      form.querySelectorAll('input[name="modo"]'),
      function (i) { return i.type === 'radio'; }
    );
    var isEdit = form.dataset.mode === 'edit';
    var urlField = form.querySelector('.field-url');
    var wifiField = form.querySelector('.field-wifi');
    var contactoField = form.querySelector('.field-contacto');
    var ssidInput = form.querySelector('input[name="wifi_ssid"]');
    var pwInput = form.querySelector('input[name="wifi_password"]');
    var secSelect = form.querySelector('select[name="wifi_seguridad"]');
    var preview = document.getElementById('wifi-preview');

    function currentModo() {
      var modo = null;
      modoInputs.forEach(function (i) { if (i.checked) modo = i.value; });
      return modo;
    }

    function updatePreview() {
      if (!preview) return;
      var sec = secSelect ? secSelect.value : 'WPA';
      var ssid = ssidInput ? ssidInput.value.trim() : '';
      var pw = pwInput ? pwInput.value : '';
      var out = 'WIFI:T:' + sec + ';S:' + (ssid || '…') + ';';
      if (sec !== 'nopass') out += 'P:' + (pw || '…') + ';';
      preview.textContent = out + ';';
    }

    function update() {
      var modo = currentModo();
      // 'block' explícito: con html.js el CSS oculta estos fieldsets (display:none),
      // así que un '' (sin override inline) los dejaría ocultos para siempre.
      if (urlField) urlField.style.display = modo === 'url' ? 'block' : 'none';
      if (wifiField) wifiField.style.display = modo === 'wifi' ? 'block' : 'none';
      if (contactoField) contactoField.style.display = modo === 'contacto' ? 'block' : 'none';
      if (ssidInput) ssidInput.required = modo === 'wifi';
      if (secSelect) secSelect.required = modo === 'wifi';
      if (pwInput) {
        pwInput.required = modo === 'wifi' && !isEdit && secSelect && secSelect.value !== 'nopass';
      }
      form.querySelectorAll('.modo-card').forEach(function (c) {
        c.classList.toggle('selected', c.querySelector('input').checked);
      });
      updatePreview();
    }

    modoInputs.forEach(function (i) { i.addEventListener('change', update); });
    if (ssidInput) ssidInput.addEventListener('input', updatePreview);
    if (pwInput) pwInput.addEventListener('input', updatePreview);
    if (secSelect) secSelect.addEventListener('change', update);
    update();
  }

  // Escritura NFC vía Web NFC API (solo Chrome en Android)
  var nfcWrite = document.getElementById('nfc-write');
  if (nfcWrite && 'NDEFReader' in window) {
    nfcWrite.hidden = false;
    document.querySelectorAll('[data-nfc-write]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.dataset.nfcWrite;
        var el = document.getElementById('nfc-payload-' + kind);
        var status = document.getElementById('nfc-status');
        if (!el || !status) return;
        var payload = el.textContent.trim();
        var record = kind === 'url'
          ? { recordType: 'url', data: payload }
          : { recordType: 'text', data: payload };
        status.textContent = 'Escribiendo… acerca la etiqueta al móvil.';
        new NDEFReader()
          .write({ records: [record] })
          .then(function () { status.textContent = '✓ Etiqueta escrita correctamente.'; })
          .catch(function (err) { status.textContent = 'Error: ' + (err && err.message ? err.message : err); });
      });
    });
  }

  function copyText(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = '✓ Copiado';
      setTimeout(function () { btn.textContent = old; }, 1800);
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