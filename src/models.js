'use strict';
const { generateSlug, isValidSlug } = require('./slugs');
const { encryptText, decryptText } = require('./crypto');
const { hashIp } = require('./helpers');

const TIPOS = ['qr', 'nfc', 'ambos'];
const MODOS = ['url', 'wifi', 'contacto', 'presentacion', 'alojamiento', 'desactivado'];
const ESTADOS = ['activo', 'pausado'];
const SEGURIDADES = ['WPA', 'WEP', 'nopass'];

const TAG_COLUMNS = `id, slug, nombre, tipo, modo, url_destino, wifi_ssid, wifi_password_enc,
  wifi_seguridad, contacto_telefono, contacto_email, pres_persona_nombre, pres_cargo, pres_bio,
  pres_foto, aloj_idioma, modo_despedida, nfc_uid, nfc_modelo, escaneos, ultimo_escaneo, estado, fecha_creacion, fecha_actualizacion`;

function nowIso() {
  return new Date().toISOString();
}

function rowToTag(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    nombre: row.nombre,
    tipo: row.tipo,
    modo: row.modo,
    urlDestino: row.url_destino,
    wifiSsid: row.wifi_ssid,
    wifiPasswordEnc: row.wifi_password_enc,
    wifiSeguridad: row.wifi_seguridad,
    contactoTelefono: row.contacto_telefono,
    contactoEmail: row.contacto_email,
    presPersonaNombre: row.pres_persona_nombre,
    presCargo: row.pres_cargo,
    presBio: row.pres_bio,
    presFoto: row.pres_foto,
    alojIdioma: row.aloj_idioma || 'es',
    modoDespedida: Boolean(row.modo_despedida),
    nfcUid: row.nfc_uid || null,
    nfcModelo: row.nfc_modelo || null,
    escaneos: row.escaneos,
    ultimoEscaneo: row.ultimo_escaneo,
    estado: row.estado,
    fechaCreacion: row.fecha_creacion,
    fechaActualizacion: row.fecha_actualizacion
  };
}

function createModels(db, config) {
  const key = config.wifiSecret;

  function decryptWifiPassword(tag) {
    if (!tag || !tag.wifiPasswordEnc) return '';
    try {
      return decryptText(tag.wifiPasswordEnc, key);
    } catch {
      return '';
    }
  }

  function listTags(filters = {}) {
    const q = String(filters.q || '').trim();
    const tipo = String(filters.tipo || '');
    const modo = String(filters.modo || '');
    const estado = String(filters.estado || '');
    const page = Math.max(1, parseInt(String(filters.page || '1'), 10) || 1);
    const perPage = 25;

    const clauses = [];
    const params = {};
    if (q) {
      clauses.push(`(nombre LIKE @q ESCAPE '\\' OR slug LIKE @q ESCAPE '\\')`);
      params.q = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    }
    if (tipo) {
      clauses.push('tipo = @tipo');
      params.tipo = tipo;
    }
    if (modo) {
      clauses.push('modo = @modo');
      params.modo = modo;
    }
    if (estado) {
      clauses.push('estado = @estado');
      params.estado = estado;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) AS c FROM tags ${where}`).get(params).c;
    const rows = db
      .prepare(
        `SELECT ${TAG_COLUMNS} FROM tags ${where}
         ORDER BY fecha_actualizacion DESC, id DESC LIMIT @limit OFFSET @offset`
      )
      .all({ ...params, limit: perPage, offset: (page - 1) * perPage });

    return { rows: rows.map(rowToTag), total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
  }

  function getTagById(id) {
    return rowToTag(db.prepare(`SELECT ${TAG_COLUMNS} FROM tags WHERE id = ?`).get(id));
  }

  function getTagBySlug(slug) {
    return rowToTag(db.prepare(`SELECT ${TAG_COLUMNS} FROM tags WHERE slug = ?`).get(slug));
  }

  // Crea N tags genéricos (stock para vender) en modo desactivado, con nombres
  // correlativos del tipo «Prefijo 1», «Prefijo 2»… Devuelve el número creado.
  function createBulkTags({ cantidad, prefijo, tipo }) {
    const n = Math.min(500, Math.max(1, parseInt(String(cantidad), 10) || 1));
    const base = String(prefijo || 'Tag').trim().slice(0, 60) || 'Tag';
    const soporte = TIPOS.includes(tipo) ? tipo : 'ambos';
    const now = nowIso();

    // Siguiente número correlativo para el prefijo elegido, para que los nombres
    // queden como «Prefijo 1», «Prefijo 2»… sin repetirse.
    const ultimo = db
      .prepare("SELECT nombre FROM tags WHERE nombre LIKE ? ORDER BY id DESC LIMIT 1")
      .get(`${base} %`);
    let siguiente = 1;
    if (ultimo) {
      const numero = parseInt(String(ultimo.nombre).replace(`${base} `, ''), 10);
      if (Number.isInteger(numero)) siguiente = numero + 1;
    }

    const insertar = db.prepare(
      `INSERT INTO tags
         (slug, nombre, tipo, modo, estado, fecha_creacion, fecha_actualizacion)
       VALUES (?, ?, ?, 'desactivado', 'activo', ?, ?)`
    );
    const crearTodos = db.transaction((cuantos) => {
      for (let i = 0; i < cuantos; i += 1) {
        let slug;
        // Los slugs son aleatorios; ante una colisión (improbable) se regenera.
        for (;;) {
          slug = generateSlug(8);
          try {
            insertar.run(slug, `${base} ${siguiente + i}`, soporte, now, now);
            break;
          } catch (err) {
            if (!String(err.message).includes('UNIQUE')) throw err;
          }
        }
      }
    });
    crearTodos(n);
    return n;
  }

  function countTagsByModo(modo) {
    return db.prepare('SELECT COUNT(*) AS c FROM tags WHERE modo = ?').get(modo).c;
  }

  // Todos los tags de un modo concreto (sin paginar) — p. ej. para el ZIP de pendientes.
  function listTagsByModo(modo) {
    return db
      .prepare(`SELECT ${TAG_COLUMNS} FROM tags WHERE modo = ? ORDER BY id ASC`)
      .all(modo)
      .map(rowToTag);
  }

  // Todos los tags sin paginar (p. ej. el desplegable de asignación de chips).
  function listAllTags() {
    return db
      .prepare(`SELECT ${TAG_COLUMNS} FROM tags ORDER BY nombre COLLATE NOCASE ASC`)
      .all()
      .map(rowToTag);
  }

  function createTag(input) {
    const slug = input.slug && isValidSlug(input.slug) ? input.slug : generateSlug(8);
    const wifiPasswordEnc = input.wifi && input.wifi.password ? encryptText(input.wifi.password, key) : null;
    const now = nowIso();
    const stmt = db.prepare(
      `INSERT INTO tags
         (slug, nombre, tipo, modo, url_destino, wifi_ssid, wifi_password_enc, wifi_seguridad,
          contacto_telefono, contacto_email, pres_persona_nombre, pres_cargo, pres_bio, pres_foto,
          aloj_idioma, nfc_uid, nfc_modelo, estado, fecha_creacion, fecha_actualizacion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    try {
      const info = stmt.run(
        slug,
        input.nombre,
        input.tipo,
        input.modo,
        input.urlDestino || null,
        input.wifi ? input.wifi.ssid : null,
        wifiPasswordEnc,
        input.wifi ? input.wifi.seguridad : null,
        input.contacto ? input.contacto.telefono : null,
        input.contacto ? input.contacto.email : null,
        input.presentacion ? input.presentacion.personaNombre || null : null,
        input.presentacion ? input.presentacion.cargo || null : null,
        input.presentacion ? input.presentacion.bio || null : null,
        input.presentacion ? input.presentacion.foto || null : null,
        input.alojIdioma || 'es',
        input.nfcUid || null,
        input.nfcModelo || null,
        input.estado,
        now,
        now
      );
      return getTagById(info.lastInsertRowid);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        const e = new Error('SLUG_TAKEN');
        e.code = 'SLUG_TAKEN';
        throw e;
      }
      throw err;
    }
  }

  function updateTag(id, input) {
    const sets = [];
    const params = {};

    if (input.nombre !== undefined) {
      sets.push('nombre = @nombre');
      params.nombre = input.nombre;
    }
    if (input.tipo !== undefined) {
      sets.push('tipo = @tipo');
      params.tipo = input.tipo;
    }
    if (input.modo !== undefined) {
      sets.push('modo = @modo');
      params.modo = input.modo;
    }
    if (input.estado !== undefined) {
      sets.push('estado = @estado');
      params.estado = input.estado;
    }
    if (input.urlDestino !== undefined) {
      sets.push('url_destino = @url_destino');
      params.url_destino = input.urlDestino || null;
    }
    if (input.clearUrl) {
      sets.push('url_destino = NULL');
    }
    if (input.contacto !== undefined) {
      sets.push('contacto_telefono = @contacto_telefono', 'contacto_email = @contacto_email');
      params.contacto_telefono = (input.contacto && input.contacto.telefono) || null;
      params.contacto_email = (input.contacto && input.contacto.email) || null;
    }
    if (input.clearContacto) {
      sets.push('contacto_telefono = NULL', 'contacto_email = NULL');
    }
    if (input.clearPresentacion) {
      sets.push(
        'pres_persona_nombre = NULL',
        'pres_cargo = NULL',
        'pres_bio = NULL',
        'pres_foto = NULL'
      );
    }
    if (input.presentacion !== undefined) {
      const p = input.presentacion || {};
      sets.push(
        'pres_persona_nombre = @pres_persona_nombre',
        'pres_cargo = @pres_cargo',
        'pres_bio = @pres_bio'
      );
      params.pres_persona_nombre = p.personaNombre || null;
      params.pres_cargo = p.cargo || null;
      params.pres_bio = p.bio || null;
      // La foto: una data URL nueva la sustituye; keepFoto conserva la actual
      // (no se toca la columna); en cualquier otro caso se limpia a NULL.
      if (p.foto) {
        sets.push('pres_foto = @pres_foto');
        params.pres_foto = p.foto;
      } else if (!p.keepFoto) {
        sets.push('pres_foto = NULL');
      }
    }
    if (input.alojIdioma !== undefined) {
      sets.push('aloj_idioma = @aloj_idioma');
      params.aloj_idioma = input.alojIdioma || 'es';
    }
    if (input.modoDespedida !== undefined) {
      sets.push('modo_despedida = @modo_despedida');
      params.modo_despedida = input.modoDespedida ? 1 : 0;
    }
    if (input.nfcUid !== undefined) {
      sets.push('nfc_uid = @nfc_uid');
      params.nfc_uid = input.nfcUid || null;
    }
    if (input.nfcModelo !== undefined) {
      sets.push('nfc_modelo = @nfc_modelo');
      params.nfc_modelo = input.nfcModelo || null;
    }
    if (input.clearWifi) {
      sets.push('wifi_ssid = NULL', 'wifi_password_enc = NULL', 'wifi_seguridad = NULL');
    } else if (input.wifi) {
      sets.push('wifi_ssid = @wifi_ssid', 'wifi_seguridad = @wifi_seguridad');
      params.wifi_ssid = input.wifi.ssid;
      params.wifi_seguridad = input.wifi.seguridad;
      // Si no se aporta contraseña nueva se conserva la existente.
      if (input.wifi.password && !input.wifi.keepPassword) {
        sets.push('wifi_password_enc = @wifi_password_enc');
        params.wifi_password_enc = encryptText(input.wifi.password, key);
      }
    }

    sets.push('fecha_actualizacion = @fecha_actualizacion');
    params.fecha_actualizacion = nowIso();
    params.id = id;
    db.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return getTagById(id);
  }

  function deleteTag(id) {
    db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  }

  function setEstado(id, estado) {
    db.prepare('UPDATE tags SET estado = ?, fecha_actualizacion = ? WHERE id = ?').run(estado, nowIso(), id);
  }

  function recordScan(tagId, req, clientIp) {
    const now = nowIso();
    db.prepare('UPDATE tags SET escaneos = escaneos + 1, ultimo_escaneo = ? WHERE id = ?').run(now, tagId);
    const info = db.prepare('INSERT INTO scans (tag_id, created_at, user_agent, ip_hash, referrer) VALUES (?, ?, ?, ?, ?)').run(
      tagId,
      now,
      String(req.headers['user-agent'] || '').slice(0, 300),
      hashIp(clientIp || req.ip),
      String(req.headers['referer'] || '').slice(0, 500) || null
    );
    return info.lastInsertRowid;
  }

  // Guarda la ubicación aproximada resuelta por IP en un escaneo concreto, o la
  // nota con el motivo si no se pudo resolver (IP privada, proveedor sin respuesta).
  function updateScanLocation(scanId, geo, note) {
    if (!scanId) return;
    if (geo) {
      db.prepare('UPDATE scans SET city = ?, region = ?, country = ?, lat = ?, lon = ?, geo_note = NULL WHERE id = ?').run(
        geo.city || null,
        geo.region || null,
        geo.country || null,
        geo.lat != null ? geo.lat : null,
        geo.lon != null ? geo.lon : null,
        scanId
      );
    } else if (note) {
      db.prepare('UPDATE scans SET geo_note = ? WHERE id = ?').run(String(note).slice(0, 200), scanId);
    }
  }

  function recentScans(tagId, limit = 10) {
    return db
      .prepare(
        'SELECT created_at, user_agent, city, region, country, lat, lon, geo_note FROM scans WHERE tag_id = ? ORDER BY id DESC LIMIT ?'
      )
      .all(tagId, limit);
  }

  // Marcas de tiempo (ISO) de todos los escaneos de un tag: materia prima para
  // las series diaria/semanal/mensual/anual de la gráfica.
  function scanTimestamps(tagId) {
    return db.prepare('SELECT created_at FROM scans WHERE tag_id = ? ORDER BY id ASC').all(tagId).map((r) => r.created_at);
  }

  // Procedencia del escaneo: con Referer llegó desde otra web; sin él, directo
  // (cámara nativa, NFC o URL escrita — indistinguibles entre sí). «sites»
  // agrega por dominio los procedentes de otras webs (top 5).
  function scanReferrerCounts(tagId) {
    const rows = db.prepare('SELECT referrer FROM scans WHERE tag_id = ?').all(tagId);
    let directo = 0;
    let web = 0;
    const byHost = new Map();
    for (const r of rows) {
      if (!r.referrer) {
        directo++;
        continue;
      }
      web++;
      try {
        const host = new URL(r.referrer).host;
        if (host) byHost.set(host, (byHost.get(host) || 0) + 1);
      } catch {
        // Referer malformado: cuenta como web pero sin sitio asociado.
      }
    }
    const sites = [...byHost.entries()]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    return { directo, web, sites };
  }

  // ---------- Bloques de alojamiento (contenido del huésped) ----------

  // Filas de tag_blocks de un tag (todos los bloques e idiomas).
  function listBlocks(tagId) {
    return db
      .prepare('SELECT id, tag_id, block_type, language, content, position, is_visible, updated_at FROM tag_blocks WHERE tag_id = ? ORDER BY block_type, language')
      .all(tagId);
  }

  // Upsert de un bloque (tag + tipo + idioma es único). Devuelve la fila.
  function upsertBlock(tagId, { blockType, language, content, position = 0, isVisible = 1 }) {
    const now = nowIso();
    db.prepare(
      `INSERT INTO tag_blocks (tag_id, block_type, language, content, position, is_visible, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tag_id, block_type, language)
       DO UPDATE SET content = excluded.content, position = excluded.position,
         is_visible = excluded.is_visible, updated_at = excluded.updated_at`
    ).run(tagId, blockType, language, JSON.stringify(content), position, isVisible ? 1 : 0, now);
    return db
      .prepare('SELECT id, tag_id, block_type, language, content, position, is_visible, updated_at FROM tag_blocks WHERE tag_id = ? AND block_type = ? AND language = ?')
      .get(tagId, blockType, language);
  }

  function deleteBlock(tagId, blockType, language) {
    db.prepare('DELETE FROM tag_blocks WHERE tag_id = ? AND block_type = ? AND language = ?').run(tagId, blockType, language);
  }

  // Borra todos los bloques de un idioma (p. ej. al vaciar una pestaña).
  function deleteBlocksByLanguage(tagId, language) {
    db.prepare('DELETE FROM tag_blocks WHERE tag_id = ? AND language = ?').run(tagId, language);
  }

  function deleteBlocksByTag(tagId) {
    db.prepare('DELETE FROM tag_blocks WHERE tag_id = ?').run(tagId);
  }

  // Localiza un tag por el UID hexadecimal de su chip NFC (p. ej. NTAG213).
  // Devuelve null si no hay ninguno asociado todavía.
  function getTagByNfcUid(uid) {
    return rowToTag(db.prepare(`SELECT ${TAG_COLUMNS} FROM tags WHERE nfc_uid = ?`).get(uid));
  }

  // Localiza un tag por el UID hexadecimal de su chip NFC (p. ej. NTAG213).
  // Devuelve null si no hay ninguno asociado todavía.
  function getTagByNfcUid(uid) {
    return rowToTag(db.prepare(`SELECT ${TAG_COLUMNS} FROM tags WHERE nfc_uid = ?`).get(uid));
  }

  // Duplica un tag y, si tiene bloques de alojamiento, los copia también.
  // Devuelve el tag nuevo.
  function duplicateTag(id, nuevoNombre) {
    const src = getTagById(id);
    if (!src) return null;
    const now = nowIso();
    let created = null;
    const run = db.transaction(() => {
      // El duplicado es una propiedad distinta: slug nuevo aleatorio (colisiones
      // improbables; se regenera si ocurren) y estado «activo».
      let info = null;
      for (;;) {
        try {
          info = db
            .prepare(
              `INSERT INTO tags (slug, nombre, tipo, modo, url_destino, wifi_ssid, wifi_password_enc, wifi_seguridad,
                 contacto_telefono, contacto_email, pres_persona_nombre, pres_cargo, pres_bio, pres_foto,
                 aloj_idioma, modo_despedida, nfc_uid, nfc_modelo, estado, fecha_creacion, fecha_actualizacion)
               SELECT ?, ?, tipo, modo, url_destino, wifi_ssid, wifi_password_enc, wifi_seguridad,
                 contacto_telefono, contacto_email, pres_persona_nombre, pres_cargo, pres_bio, pres_foto,
                 aloj_idioma, modo_despedida, NULL, NULL, 'activo', ?, ?
               FROM tags WHERE id = ?`
            )
            .run(generateSlug(8), nuevoNombre, now, now, id);
          break;
        } catch (err) {
          if (!String(err.message).includes('UNIQUE')) throw err;
        }
      }
      created = getTagById(info.lastInsertRowid);
      // Bloques de alojamiento: se copian tal cual (la contraseña WiFi copiada
      // sigue cifrada con la misma clave).
      db.prepare(
        `INSERT INTO tag_blocks (tag_id, block_type, language, content, position, is_visible, updated_at)
         SELECT ?, block_type, language, content, position, is_visible, updated_at
         FROM tag_blocks WHERE tag_id = ?`
      ).run(created.id, id);
    });
    run();
    return created;
  }

  function findUserByUsername(username) {
    return db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  }

  function createUser(username, passwordHash) {
    return db
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, passwordHash, nowIso()).lastInsertRowid;
  }

  function updateUserPassword(id, passwordHash) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  return {
    decryptWifiPassword,
    listTags,
    getTagById,
    getTagBySlug,
    createTag,
    createBulkTags,
    countTagsByModo,
    listTagsByModo,
    listAllTags,
    updateTag,
    deleteTag,
    setEstado,
    recordScan,
    getTagByNfcUid,
    scanTimestamps,
    scanReferrerCounts,
    updateScanLocation,
    recentScans,
    listBlocks,
    upsertBlock,
    deleteBlock,
    deleteBlocksByLanguage,
    deleteBlocksByTag,
    duplicateTag,
    findUserByUsername,
    createUser,
    updateUserPassword
  };
}

module.exports = { createModels, TIPOS, MODOS, ESTADOS, SEGURIDADES };