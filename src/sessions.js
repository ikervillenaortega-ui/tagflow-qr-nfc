'use strict';
const session = require('express-session');

// Store de sesiones para express-session respaldado en SQLite.
// Persistente entre reinicios y válido para varios procesos.
// Debe extender session.Store: aporta el EventEmitter (store.on para
// 'disconnect'/'connect') y createSession(), que express-session invoca
// al inflar cada sesión.
class SqliteSessionStore extends session.Store {
  constructor(db, ttlMs) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    // express-session puede desestructurar los métodos
    this.get = this.get.bind(this);
    this.set = this.set.bind(this);
    this.destroy = this.destroy.bind(this);
    this.touch = this.touch.bind(this);
  }

  // Los callbacks pueden llegar como undefined (p. ej. req.session.destroy() sin
  // callback, algo que MemoryStore tolera): se invocan solo si son funciones.
  get(sid, cb) {
    try {
      const row = this.db
        .prepare('SELECT data FROM sessions WHERE id = ? AND expires_at > ?')
        .get(sid, Date.now());
      if (typeof cb === 'function') cb(null, row ? JSON.parse(row.data) : undefined);
    } catch (err) {
      if (typeof cb === 'function') cb(err);
    }
  }

  set(sid, data, cb) {
    try {
      this.db
        .prepare(
          `INSERT INTO sessions (id, data, expires_at, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
        )
        .run(sid, JSON.stringify(data), Date.now() + this.ttlMs, Date.now());
      if (typeof cb === 'function') cb(null);
    } catch (err) {
      if (typeof cb === 'function') cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
      if (typeof cb === 'function') cb(null);
    } catch (err) {
      if (typeof cb === 'function') cb(err);
    }
  }

  touch(sid, data, cb) {
    try {
      this.db
        .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
        .run(Date.now() + this.ttlMs, sid);
      if (typeof cb === 'function') cb(null);
    } catch (err) {
      if (typeof cb === 'function') cb(err);
    }
  }
}

module.exports = { SqliteSessionStore };