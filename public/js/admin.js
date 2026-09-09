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

  // Restaurar copia de seguridad (subida del fichero .db en crudo)
  var backupBox = document.getElementById('backup-restore');
  if (backupBox) {
    var fileInput = document.getElementById('backup-file');
    var restoreBtn = document.getElementById('backup-restore-btn');
    var statusEl = document.getElementById('backup-status');
    var fileNameEl = document.getElementById('backup-file-name');

    function setStatus(text, ok) {
      statusEl.textContent = text;
      statusEl.className = ok ? 'backup-ok' : 'backup-err';
    }

    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (fileNameEl) fileNameEl.textContent = f ? '✓ ' + f.name : 'Elige un fichero .db de TagFlow…';
      if (restoreBtn) restoreBtn.disabled = !f;
      if (statusEl) { statusEl.textContent = ''; statusEl.className = 'muted'; }
    });

    restoreBtn.addEventListener('click', function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      setStatus('Subiendo y restaurando… no cierres esta página.', false);
      restoreBtn.disabled = true;
      fetch('/admin/backup/restaurar', {
        method: 'POST',
        headers: { 'X-CSRF-Token': backupBox.dataset.csrf },
        body: f
      })
        .then(function (r) {
          return r.json().catch(function () { return null; }).then(function (j) { return { okHttp: r.ok, json: j }; });
        })
        .then(function (out) {
          if (out.json && out.json.ok) {
            setStatus('✓ Copia restaurada correctamente. Recargando…', true);
            setTimeout(function () { window.location.reload(); }, 1200);
          } else {
            setStatus('✗ ' + ((out.json && out.json.error) || 'No se pudo restaurar. Comprueba que el fichero es una copia de TagFlow.'), false);
            restoreBtn.disabled = false;
          }
        })
        .catch(function () {
          setStatus('✗ Error de conexión. Inténtalo de nuevo.', false);
          restoreBtn.disabled = false;
        });
    });
  }

  // ===== Gráfica de escaneos (barras CSS, sin librerías) =====
  var chartPanel = document.getElementById('chart-panel');
  if (chartPanel) {
    var TAG_ID = chartPanel.dataset.tagId;
    var series = null;
    try { series = JSON.parse(chartPanel.dataset.series || 'null'); } catch (e) { series = null; }
    var rangeNames = { daily: 'Día', weekly: 'Semana', monthly: 'Mes', yearly: 'Año' };
    var canvas = document.getElementById('chart-canvas');
    var currentRange = 'daily';

    function drawChart() {
      if (!canvas || !series || !series[currentRange]) return;
      var data = series[currentRange];
      var max = 0;
      for (var i = 0; i < data.length; i++) if (data[i].count > max) max = data[i].count;
      canvas.innerHTML = '';
      var frag = document.createDocumentFragment();
      for (var j = 0; j < data.length; j++) {
        (function (bucket) {
          var bar = document.createElement('div');
          bar.className = 'chart-bar' + (bucket.count === 0 ? ' zero' : '');
          var h = max > 0 ? Math.round((bucket.count / max) * 100) : 0;
          bar.style.height = (bucket.count > 0 && h < 4 ? 4 : h) + '%';
          var tip = document.createElement('span');
          tip.className = 'tip';
          tip.textContent = rangeNames[currentRange] + ' ' + bucket.label + ': ' + bucket.count + (bucket.count === 1 ? ' escaneo' : ' escaneos');
          bar.appendChild(tip);
          frag.appendChild(bar);
        })(data[j]);
      }
      canvas.appendChild(frag);

      // Etiquetas del eje X: muestro 6 como máximo (cada N barras).
      var oldX = canvas.parentNode.querySelector('.chart-xlabels');
      if (oldX) oldX.remove();
      var step = Math.ceil(data.length / 6);
      var x = document.createElement('div');
      x.className = 'chart-xlabels';
      for (var k = 0; k < data.length; k++) {
        var lab = document.createElement('span');
        if (k % step === 0) {
          lab.textContent = data[k].label;
          lab.className = 'show';
        }
        x.appendChild(lab);
      }
      canvas.parentNode.appendChild(x);
    }

    chartPanel.querySelectorAll('.chart-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        currentRange = tab.dataset.range;
        chartPanel.querySelectorAll('.chart-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        drawChart();
      });
    });

    drawChart();

    // Refresco de la gráfica al volver a la pestaña (y cada 5 min si está visible).
    var REFRESH_MS = 5 * 60 * 1000;
    function refreshData() {
      fetch('/admin/tags/' + TAG_ID + '/scans.json', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) {
          if (!json || !json.series) return;
          series = json.series;
          var tot = document.getElementById('chart-total-num');
          if (tot && json.total != null) tot.textContent = json.total;
          drawChart();
        })
        .catch(function () { /* silencioso: la próxima visita lo refresca */ });
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshData();
    });
    setInterval(function () {
      if (!document.hidden) refreshData();
    }, REFRESH_MS);
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