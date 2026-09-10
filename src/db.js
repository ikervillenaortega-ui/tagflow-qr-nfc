'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Migraciones: se aplican en orden según la versión registrada en _meta.
const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'qr' CHECK (tipo IN ('qr','nfc','ambos')),
        modo TEXT NOT NULL DEFAULT 'desactivado' CHECK (modo IN ('url','wifi','desactivado')),
        url_destino TEXT,
        wifi_ssid TEXT,
        wifi_password_enc TEXT,
        wifi_seguridad TEXT CHECK (wifi_seguridad IN ('WPA','WEP','nopass')),
        escaneos INTEGER NOT NULL DEFAULT 0,
        ultimo_escaneo TEXT,
        estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','pausado')),
        fecha_creacion TEXT NOT NULL,
        fecha_actualizacion TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        user_agent TEXT,
        ip_hash TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_scans_tag_created ON scans(tag_id, created_at);
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  },
  {
    // Geolocalización de escaneos: ubicación aproximada resuelta por IP
    // (ciudad/región/país + coordenadas), de forma opcional y best-effort.
    version: 3,
    sql: `
      ALTER TABLE scans ADD COLUMN city TEXT;
      ALTER TABLE scans ADD COLUMN region TEXT;
      ALTER TABLE scans ADD COLUMN country TEXT;
      ALTER TABLE scans ADD COLUMN lat REAL;
      ALTER TABLE scans ADD COLUMN lon REAL;
    `
  },
  {
    // Nota explicativa cuando no se pudo resolver la ubicación de un escaneo
    // (IP privada, proveedor geo sin respuesta, etc.), para que el panel muestre
    // el motivo en vez de un genérico «no disponible».
    version: 4,
    sql: `
      ALTER TABLE scans ADD COLUMN geo_note TEXT;
    `
  },
  {
    // Modo Contacto: teléfono y correo que se muestran al escanear el QR/NFC.
    // SQLite no permite modificar un CHECK con ALTER, así que se reconstruye la
    // tabla tags con el nuevo CHECK que admite el modo 'contacto'.
    version: 5,
    sql: `
      CREATE TABLE tags_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'qr' CHECK (tipo IN ('qr','nfc','ambos')),
        modo TEXT NOT NULL DEFAULT 'desactivado' CHECK (modo IN ('url','wifi','contacto','desactivado')),
        url_destino TEXT,
        wifi_ssid TEXT,
        wifi_password_enc TEXT,
        wifi_seguridad TEXT CHECK (wifi_seguridad IN ('WPA','WEP','nopass')),
        contacto_telefono TEXT,
        contacto_email TEXT,
        escaneos INTEGER NOT NULL DEFAULT 0,
        ultimo_escaneo TEXT,
        estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','pausado')),
        fecha_creacion TEXT NOT NULL,
        fecha_actualizacion TEXT NOT NULL
      );

      INSERT INTO tags_new (id, slug, nombre, tipo, modo, url_destino, wifi_ssid, wifi_password_enc,
        wifi_seguridad, escaneos, ultimo_escaneo, estado, fecha_creacion, fecha_actualizacion)
        SELECT id, slug, nombre, tipo, modo, url_destino, wifi_ssid, wifi_password_enc,
          wifi_seguridad, escaneos, ultimo_escaneo, estado, fecha_creacion, fecha_actualizacion
        FROM tags;

      DROP TABLE tags;
      ALTER TABLE tags_new RENAME TO tags;
    `
  },
  {
    // Procedencia del escaneo: página que envió al visitante a la URL del tag
    // (cámara nativa → sin referrer; otra web → su URL; vacío → origen vacío).
    version: 6,
    sql: `
      ALTER TABLE scans ADD COLUMN referrer TEXT;
    `
  },
  {
    // Modo Presentación: tarjeta personal digital (foto circular, nombre de la
    // persona, cargo, descripción) con el contacto al final. La foto se guarda
    // como data URL (JPEG cuadrado ya optimizado en el cliente). Como SQLite no
    // permite modificar un CHECK con ALTER, se reconstruye la tabla tags con el
    // CHECK que admite el modo 'presentacion' y las columnas nuevas.
    version: 7,
    sql: `
      CREATE TABLE tags_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'qr' CHECK (tipo IN ('qr','nfc','ambos')),
        modo TEXT NOT NULL DEFAULT 'desactivado' CHECK (modo IN ('url','wifi','contacto','presentacion','desactivado')),
        url_destino TEXT,
        wifi_ssid TEXT,
        wifi_password_enc TEXT,
        wifi_seguridad TEXT CHECK (wifi_seguridad IN ('WPA','WEP','nopass')),
        contacto_telefono TEXT,
        contacto_email TEXT,
        pres_persona_nombre TEXT,
        pres_cargo TEXT,
        pres_bio TEXT,
        pres_foto TEXT,
        escaneos INTEGER NOT NULL DEFAULT 0,
        ultimo_escaneo TEXT,
        estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','pausado')),
        fecha_creacion TEXT NOT NULL,
        fecha_actualizacion TEXT NOT NULL
      );

      INSERT INTO tags_new (id, slug, nombre, tipo, modo, url_destino, wifi_ssid, wifi_password_enc,
        wifi_seguridad, contacto_telefono, contacto_email, escaneos, ultimo_escaneo, estado,
        fecha_creacion, fecha_actualizacion)
        SELECT id, slug, nombre, tipo, modo, url_destino, wifi_ssid, wifi_password_enc,
          wifi_seguridad, contacto_telefono, contacto_email, escaneos, ultimo_escaneo, estado,
          fecha_creacion, fecha_actualizacion
        FROM tags;

      DROP TABLE tags;
      ALTER TABLE tags_new RENAME TO tags;
    `
  },
  {
    // Módulo de Alojamientos Turísticos: un tag en modo 'alojamiento' muestra al
    // huésped una guía editable por bloques (acceso, WiFi, normas, manual,
    // recomendaciones, contacto, reseña). El contenido vive en tag_blocks
    // (una fila por bloque, idioma y tag) como JSON libre; la contraseña WiFi
    // del bloque se guarda cifrada. 'modo_despedida' prepara el cambio a
    // «priorizar reseña» al final de la estancia. Como SQLite no permite
    // modificar un CHECK con ALTER, se reconstruye la tabla tags.
    version: 8,
    sql: `
      CREATE TABLE tags_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'qr' CHECK (tipo IN ('qr','nfc','ambos')),
        modo TEXT NOT NULL DEFAULT 'desactivado' CHECK (modo IN ('url','wifi','contacto','presentacion','alojamiento','desactivado')),
        url_destino TEXT,
        wifi_ssid TEXT,
        wifi_password_enc TEXT,
        wifi_seguridad TEXT CHECK (wifi_seguridad IN ('WPA','WEP','nopass')),
        contacto_telefono TEXT,
        contacto_email TEXT,
        pres_persona_nombre TEXT,
        pres_cargo TEXT,
        pres_bio TEXT,
        pres_foto TEXT,
        aloj_idioma TEXT NOT NULL DEFAULT 'es',
        modo_despedida INTEGER NOT NULL DEFAULT 0,
        escaneos INTEGER NOT NULL DEFAULT 0,
        ultimo_escaneo TEXT,
        estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','pausado')),
        fecha_creacion TEXT NOT NULL,
        fecha_actualizacion TEXT NOT NULL
      );

      INSERT INTO tags_new (id, slug, nombre, tipo, modo, url_destino, wifi_ssid, wifi_password_enc,
        wifi_seguridad, contacto_telefono, contacto_email, pres_persona_nombre, pres_cargo, pres_bio,
        pres_foto, escaneos, ultimo_escaneo, estado, fecha_creacion, fecha_actualizacion)
        SELECT id, slug, nombre, tipo, modo, url_destino, wifi_ssid, wifi_password_enc,
          wifi_seguridad, contacto_telefono, contacto_email, pres_persona_nombre, pres_cargo, pres_bio,
          pres_foto, escaneos, ultimo_escaneo, estado, fecha_creacion, fecha_actualizacion
        FROM tags;

      DROP TABLE tags;
      ALTER TABLE tags_new RENAME TO tags;

      CREATE TABLE IF NOT EXISTS tag_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        block_type TEXT NOT NULL CHECK (block_type IN ('acceso','wifi','normas','manual','recomendaciones','contacto','resena')),
        language TEXT NOT NULL DEFAULT 'es',
        content TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        is_visible INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT,
        UNIQUE (tag_id, block_type, language)
      );

      CREATE INDEX IF NOT EXISTS idx_tag_blocks_tag ON tag_blocks(tag_id);
    `
  }
];

function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Durante las migraciones se desactiva foreign_keys (no se puede cambiar
  // dentro de una transacción): la reconstrucción de la tabla tags (migración 5)
  // necesita borrar la tabla padre sin que el DELETE implícito falle por las
  // filas de scans que la referencian. Se reactivan al terminar.
  db.pragma('foreign_keys = OFF');
  migrate(db);
  db.pragma('foreign_keys = ON');
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS _meta (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM _meta').get();
  let current = row && row.v ? row.v : 0;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      // db.transaction(fn) devuelve la función envuelta: hay que invocarla.
      db.transaction(() => {
        db.exec(m.sql);
        db.prepare('INSERT INTO _meta (version) VALUES (?)').run(m.version);
      })();
      current = m.version;
    }
  }
}

module.exports = { openDb, MIGRATIONS };