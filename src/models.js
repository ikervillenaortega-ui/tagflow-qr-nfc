'use strict';
const { generateSlug, isValidSlug } = require('./slugs');
const { encryptText, decryptText } = require('./crypto');
const { hashIp } = require('./helpers');

const TIPOS = ['qr', 'nfc', 'ambos'];
const MODOS = ['url', 'wifi', 'desactivado'];
const ESTADOS = ['activo', 'pausado'];
const SEGURIDADES = ['WPA', 'WEP', 'nopass'];

const TAG_COLUMNS = `id, slug, nombre, tipo, modo, url_destino, wifi_ssid, wifi_password_enc,
  wifi_seguridad, escaneos, ultimo_escaneo, estado, fecha_creacion, fecha_actualizacion`;

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

  function createTag(input) {
    const slug = input.slug && isValidSlug(input.slug) ? input.slug : generateSlug(8);
    const wifiPasswordEnc = input.wifi && input.wifi.password ? encryptText(input.wifi.password, key) : null;
    const now = nowIso();
    const stmt = db.prepare(
      `INSERT INTO tags
         (slug, nombre, tipo, modo, url_destino, wifi_ssid, wifi_password_enc, wifi_seguridad, estado, fecha_creacion, fecha_actualizacion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

  function recordScan(tagId, req) {
    const now = nowIso();
    db.prepare('UPDATE tags SET escaneos = escaneos + 1, ultimo_escaneo = ? WHERE id = ?').run(now, tagId);
    db.prepare('INSERT INTO scans (tag_id, created_at, user_agent, ip_hash) VALUES (?, ?, ?, ?)').run(
      tagId,
      now,
      String(req.headers['user-agent'] || '').slice(0, 300),
      hashIp(req.ip)
    );
  }

  function recentScans(tagId, limit = 10) {
    return db
      .prepare('SELECT created_at, user_agent FROM scans WHERE tag_id = ? ORDER BY id DESC LIMIT ?')
      .all(tagId, limit);
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
    updateTag,
    deleteTag,
    setEstado,
    recordScan,
    recentScans,
    findUserByUsername,
    createUser,
    updateUserPassword
  };
}

module.exports = { createModels, TIPOS, MODOS, ESTADOS, SEGURIDADES };