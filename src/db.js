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
  }
];

function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
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