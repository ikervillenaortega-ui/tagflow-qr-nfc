'use strict';
// Copias de seguridad de la base de datos.
//
// - Descargar: se hace un snapshot consistente con VACUUM INTO (funciona también
//   con bases de datos en memoria y bajo cualquier implementación de
//   better-sqlite3 / bun:sqlite), sin tocar la conexión abierta.
// - Restaurar: se copian los datos tabla a tabla sobre la conexión viva, sin
//   reiniciar el proceso. Solo se restauran las tablas de datos (tags, scans,
//   meta); no se tocan users (para no arriesgar el acceso al panel), sessions
//   (para no cerrar la sesión actual) ni _meta (registro de migraciones, que se
//   mantiene en la versión de la app). Las columnas que la copia no tenga
//   (copias antiguas) se dejan con su valor por defecto.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000');
const RESTORE_TABLES = ['scans', 'tags', 'meta'];

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

function tempPath(prefix) {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`
  );
}

// Snapshot consistente de la base de datos actual en un fichero nuevo.
function backupToFile(db, destPath) {
  db.exec(`VACUUM INTO '${String(destPath).replace(/'/g, "''")}'`);
}

// Sustituye los datos de tags/scans/meta por los del fichero de copia.
// Devuelve el recuento resultante { tags, scans }.
function restoreFromFile(db, backupPath) {
  const bak = new Database(backupPath, { readonly: true });
  try {
    if (!tableColumns(bak, 'tags').includes('slug')) {
      const err = new Error('El fichero no parece una copia de TagFlow (no contiene la tabla de Tags).');
      err.code = 'NOT_TAGFLOW';
      throw err;
    }
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        for (const table of RESTORE_TABLES) {
          const curCols = tableColumns(db, table);
          const bakCols = tableColumns(bak, table);
          const cols = curCols.filter((c) => bakCols.includes(c));
          if (!cols.length) continue;
          db.prepare(`DELETE FROM ${table}`).run();
          const rows = bak.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all();
          if (!rows.length) continue;
          const insert = db.prepare(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
          );
          for (const row of rows) insert.run(...cols.map((c) => row[c]));
        }
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    return {
      tags: db.prepare('SELECT COUNT(*) AS c FROM tags').get().c,
      scans: db.prepare('SELECT COUNT(*) AS c FROM scans').get().c
    };
  } finally {
    try {
      bak.close();
    } catch (_) {
      /* ya cerrada */
    }
  }
}

function isValidSqliteBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 100 && buffer.subarray(0, 16).equals(SQLITE_MAGIC);
}

module.exports = { backupToFile, restoreFromFile, isValidSqliteBuffer, tempPath };
