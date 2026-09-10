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
    var presField = form.querySelector('.field-presentacion');
    var ssidInput = form.querySelector('input[name="wifi_ssid"]');
    var pwInput = form.querySelector('input[name="wifi_password"]');
    var secSelect = form.querySelector('select[name="wifi_seguridad"]');
    var preview = document.getElementById('wifi-preview');

    // ===== Presentación personal: foto, contador de descripción =====
    var MAX_DIM = 512;
    var MAX_BYTES = 300 * 1024;
    var fotoInput = document.getElementById('pres-foto-input');
    var fotoData = document.getElementById('pres-foto-data');
    var fotoClear = document.getElementById('pres-foto-clear');
    var fotoPreview = document.getElementById('pres-photo-preview');
    var fotoPlaceholder = document.getElementById('pres-photo-placeholder');
    var fotoRemove = document.getElementById('pres-foto-remove');
    var fotoNote = document.getElementById('pres-foto-note');
    var bioInput = document.getElementById('pres-bio');
    var bioCount = document.getElementById('pres-bio-count');

    function setFotoPreview(dataUrl) {
      if (!fotoPreview || !fotoPlaceholder) return;
      if (dataUrl) {
        fotoPreview.src = dataUrl;
        fotoPreview.hidden = false;
        fotoPlaceholder.style.display = 'none';
        if (fotoRemove) fotoRemove.hidden = false;
        if (fotoNote) fotoNote.textContent = '✓ Foto lista. Se guardará al pulsar «Guardar cambios».';
      } else {
        fotoPreview.hidden = true;
        fotoPreview.src = '';
        fotoPlaceholder.style.display = 'flex';
        if (fotoRemove) fotoRemove.hidden = true;
        if (fotoNote) fotoNote.textContent = 'JPG o PNG. Se ajusta sola a un círculo perfecto.';
      }
    }

    function readFoto(file) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          // Cuadrado centrado (recorte tipo avatar) y reducido: la imagen se
          // guarda como JPEG optimizado en un data URL.
          var side = Math.min(img.width, img.height);
          var scale = Math.min(1, MAX_DIM / side);
          var size = Math.max(1, Math.round(side * scale));
          var c = document.createElement('canvas');
          c.width = size;
          c.height = size;
          var ctx = c.getContext('2d');
          var sx = (img.width - side) / 2;
          var sy = (img.height - side) / 2;
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
          var quality = 0.9;
          var out = c.toDataURL('image/jpeg', quality);
          while (out.length > MAX_BYTES && quality > 0.4) {
            quality -= 0.1;
            out = c.toDataURL('image/jpeg', quality);
          }
          if (fotoData) fotoData.value = out;
          if (fotoClear) fotoClear.value = '0';
          setFotoPreview(out);
        };
        img.onerror = function () {
          if (fotoNote) fotoNote.textContent = '✗ No se pudo leer la imagen. Prueba con otro fichero.';
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    }

    if (fotoInput) {
      fotoInput.addEventListener('change', function () {
        var f = fotoInput.files && fotoInput.files[0];
        if (!f) return;
        if (!/^image\/(png|jpeg)$/.test(f.type)) {
          if (fotoNote) fotoNote.textContent = '✗ Formato no soportado: usa JPG o PNG.';
          return;
        }
        readFoto(f);
      });
    }
    if (fotoRemove) {
      fotoRemove.addEventListener('click', function () {
        if (fotoData) fotoData.value = '';
        if (fotoClear) fotoClear.value = '1';
        if (fotoInput) fotoInput.value = '';
        setFotoPreview(null);
        if (fotoNote) fotoNote.textContent = 'La foto se quitará al guardar los cambios.';
      });
    }
    if (bioInput && bioCount) {
      var syncBio = function () { bioCount.textContent = String(bioInput.value.length); };
      bioInput.addEventListener('input', syncBio);
      syncBio();
    }

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
      if (contactoField) contactoField.style.display = (modo === 'contacto' || modo === 'presentacion') ? 'block' : 'none';
      if (presField) presField.style.display = modo === 'presentacion' ? 'block' : 'none';
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

  // ===== Alojamiento: pestañas de idioma + visibilidad de bloques =====
  // Cada idioma se guarda por separado (b_{lang}_present marca los idiomas con
  // contenido) y cada bloque solo se muestra si tiene algo escrito.
  var tagForm = document.getElementById('tag-form');
  var alojField = tagForm ? tagForm.querySelector('.field-alojamiento') : null;
  if (alojField) {
    // ---- Editor de filas (normas, manual, recomendaciones) ----
    // Las filas visibles son inputs normales; los "seeds" ocultos que renderiza
    // el servidor llevan el valor al POST. syncNames los renumera/crea al vuelo
    // desde las filas visibles, y el marker _present indica si el bloque tiene
    // contenido. Sin JS, los seeds del servidor se envían tal cual.
    function initRowlist(list) {
      var tpl = list.querySelector('[data-row-tpl]');
      var rowsBox = list.querySelector('.rowlist-rows');
      var marker = list.querySelector('input[type="hidden"][name="' + list.dataset.marker + '"]');
      var host = list.parentNode; // .aloj-field: contiene los seeds del servidor

      function syncNames() {
        host.querySelectorAll('.seed-hidden').forEach(function (hid) { hid.remove(); });
        var n = 0;
        rowsBox.querySelectorAll('.rowlist-row').forEach(function (row) {
          var hasAny = false;
          row.querySelectorAll('[data-rf]').forEach(function (inp) {
            if (String(inp.value).trim() === '') return;
            hasAny = true;
            var hid = document.createElement('input');
            hid.type = 'hidden';
            hid.className = 'seed-hidden';
            hid.name = list.dataset.prefix + '_' + n + '_' + inp.dataset.rf;
            hid.value = inp.value;
            host.appendChild(hid);
          });
          if (hasAny) n++;
        });
        if (marker) marker.value = n > 0 ? '1' : '0';
      }

      function addRow(values) {
        var node = tpl.content.cloneNode(true);
        rowsBox.appendChild(node);
        var row = rowsBox.querySelector('.rowlist-row:last-child');
        if (values) {
          Object.keys(values).forEach(function (k) {
            var inp = row.querySelector('[data-rf="' + k + '"]');
            if (inp) inp.value = values[k] || '';
          });
        }
        row.querySelector('.rowlist-del').addEventListener('click', function () {
          row.remove();
          syncNames();
        });
        row.addEventListener('input', function () { syncNames(); });
        syncNames();
      }

      list.querySelector('[data-row-add]').addEventListener('click', function () { addRow(); });

      // Cargar las filas existentes desde los seeds del servidor.
      var existing = [];
      host.querySelectorAll('.seed-hidden').forEach(function (hid) {
        var m = new RegExp('^' + list.dataset.prefix + '_(\\d+)_(title|text|description|media_url|category)$').exec(hid.name);
        if (!m) return;
        var idx = parseInt(m[1], 10);
        existing[idx] = existing[idx] || {};
        existing[idx][m[2]] = hid.value;
      });
      existing.forEach(function (v) { addRow(v || {}); });
      if (!existing.length) addRow({}); // una fila vacía lista para escribir

      return { syncNames: syncNames };
    }

    var rowlists = [];
    alojField.querySelectorAll('[data-rowlist]').forEach(function (list) {
      rowlists.push(initRowlist(list));
    });

    var setLangState = function (lang) {
      var wrapEl = alojField.querySelector('.aloj-lang[data-lang="' + lang + '"]');
      if (!wrapEl) return;
      var has = false;
      wrapEl.querySelectorAll('[name^="b_' + lang + '_"]').forEach(function (input) {
        if (input.type === 'hidden') {
          if (input.name.indexOf('_present') !== -1 && input.value === '1') has = true;
          return;
        }
        if (input.name.indexOf('_password') !== -1) return; // nunca cuenta
        if (String(input.value).trim() !== '') has = true;
      });
      var presentInput = wrapEl.querySelector('input[name="b_' + lang + '_present"]');
      if (presentInput) presentInput.value = has ? '1' : '0';
      var stateEl = wrapEl.querySelector('.aloj-lang-state');
      if (stateEl) stateEl.textContent = has ? '· con contenido ✓' : '';
      wrapEl.querySelectorAll('.aloj-section[data-block]').forEach(function (sec) {
        var blockName = sec.dataset.block;
        var any = false;
        sec.querySelectorAll('input:not([type="hidden"]), textarea').forEach(function (inp) {
          if (blockName === 'wifi' && /_password$/.test(inp.name || '')) return;
          if (String(inp.value).trim() !== '') any = true;
        });
        // Bloques de listas: el marker _present del servidor dice si hay items.
        if (!any) {
          var mk = sec.querySelector('input[type="hidden"][name="b_' + lang + '_' + blockName + '_present"]');
          if (mk && mk.value === '1') any = true;
        }
        sec.classList.toggle('shown', any);
      });
    };

    function refreshAlojState() {
      ['es', 'en'].forEach(setLangState);
    }

    alojField.querySelectorAll('.aloj-lang-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var lang = tab.dataset.langTab;
        alojField.querySelectorAll('.aloj-lang').forEach(function (wrapEl) {
          var body = wrapEl.querySelector('.aloj-lang-body');
          var isThis = wrapEl.dataset.lang === lang;
          if (body) body.hidden = !isThis;
          wrapEl.classList.toggle('open', isThis);
        });
        alojField.querySelectorAll('.aloj-lang-tab').forEach(function (tb) {
          tb.classList.toggle('active', tb.dataset.langTab === lang);
        });
      });
    });

    ['es', 'en'].forEach(function (lang) {
      var wrapEl = alojField.querySelector('.aloj-lang[data-lang="' + lang + '"]');
      if (!wrapEl) return;
      wrapEl.addEventListener('input', function (e) {
        var t = e.target;
        if (t.name && t.name.indexOf('b_' + lang + '_') === 0) setLangState(lang);
      });
    });

    setLangState('es');
    setLangState('en');

    // Antes de enviar: re-sincronizar filas (por si algún navegador no disparó input).
    tagForm.addEventListener('submit', function () {
      rowlists.forEach(function (rl) { rl.syncNames(); });
    });
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

  // ===== Lectura del chip NFC (Web NFC) =====
  // Lee el UID del chip (p. ej. NTAG213). En la página «Identificar NFC"
  // hace búsqueda en vivo y rellena el formulario de asignación; en el
  // formulario de tag rellena el campo UID directamente.
  (function initNfcReader() {
    if (!('NDEFReader' in window)) return;
    var ndef = null;
    var readerBtn = document.getElementById('nfc-read-btn');
    var inlineBtn = document.getElementById('nfc-read-inline');
    var statusEl = document.getElementById('nfc-status');
    var inlineStatus = document.getElementById('nfc-read-status');
    var webBox = document.getElementById('nfc-web');
    var noSupport = document.getElementById('nfc-nosupport');

    if (webBox && noSupport) {
      webBox.hidden = false;
      noSupport.hidden = true;
    }
    if (inlineBtn) inlineBtn.hidden = false;

    function setStatus(el, msg, isError) {
      if (!el) return;
      el.textContent = msg;
      el.classList.toggle('nfc-error', !!isError);
    }

    function uidFromSerial(serial) {
      return String(serial || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    }

    // NTAG213: UID de 7 bytes → 14 dígitos hex. El modelo se deduce del tamaño
    // del UID (solo orientativo: los clones pueden variar).
    function modelHint(uid) {
      if (uid.length === 8) return 'MIFARE Classic / NTAG probable';
      if (uid.length === 14) return 'NTAG213 (o compatible, UID de 7 bytes)';
      if (uid.length === 16) return 'NTAG216 / UID de 8 bytes';
      return 'Chip NTAG compatible';
    }

    function handleUid(uid) {
      var idInput = document.getElementById('nfc-uid-input');
      var uidDisplay = document.getElementById('nfc-uid-display');
      var modelHintEl = document.getElementById('nfc-model-hint');
      var resultBox = document.getElementById('nfc-result');
      var formField = document.getElementById('nfc-uid-field');

      if (formField) {
        formField.value = uid;
        setStatus(inlineStatus, 'Chip leído: ' + uid + ' ✓', false);
      }
      if (!idInput) return; // estamos en el formulario de tag: ya está

      idInput.value = uid;
      if (uidDisplay) uidDisplay.textContent = uid;
      if (modelHintEl) modelHintEl.textContent = modelHint(uid);
      if (resultBox) resultBox.hidden = false;
      setStatus(statusEl, 'Chip leído correctamente.', false);

      // Búsqueda en vivo: ¿ya pertenece a una ficha?
      fetch('/admin/nfc/buscar.json?uid=' + encodeURIComponent(uid), { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var known = document.getElementById('nfc-known');
          if (!known) return;
          if (data && data.found) {
            known.innerHTML = 'Asignado a <a href="/admin/tags/' + data.tagId + '"><strong>' + data.nombre + '</strong></a> — puedes reasignarlo abajo.';
          } else {
            known.textContent = 'Chip nuevo: todavía sin asignar a ninguna ficha.';
          }
        })
        .catch(function () { /* sin búsqueda en vivo */ });
    }

    async function readTag() {
      try {
        if (!ndef) ndef = new NDEFReader();
        await ndef.scan();
        setStatus(statusEl || inlineStatus, 'Lectura activa: acerca la tarjeta…', false);
        ndef.onreading = function (event) {
          var uid = uidFromSerial(event.serialNumber);
          if (!uid) {
            setStatus(statusEl || inlineStatus, 'No se pudo leer el UID. Prueba de acercar la tarjeta de nuevo.', true);
            return;
          }
          handleUid(uid);
        };
        ndef.onreadingerror = function () {
          setStatus(statusEl || inlineStatus, 'Error de lectura: mantén la tarjeta quieta sobre el lector.', true);
        };
      } catch (err) {
        var msg = 'No se pudo activar el lector NFC';
        if (err && err.name === 'NotAllowedError') msg = 'Permiso denegado: acepta el permiso NFC para leer la tarjeta.';
        if (err && err.name === 'NotSupportedError') msg = 'Este dispositivo no soporta Web NFC.';
        setStatus(statusEl || inlineStatus, msg + '.', true);
      }
    }

    if (readerBtn) readerBtn.addEventListener('click', readTag);
    if (inlineBtn) inlineBtn.addEventListener('click', readTag);
  })();
})();