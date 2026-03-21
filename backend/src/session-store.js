'use strict';
/**
 * SQLite-backed express-session store.
 *
 * Uses the same better-sqlite3 database as the token store so sessions
 * survive backend restarts (e.g. Render sleep/wake cycles).  No extra
 * dependencies required.
 */

const session = require('express-session');

class SQLiteStore extends session.Store {
    constructor(db) {
        super();
        this._db = db;

        db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                sid     TEXT    PRIMARY KEY,
                data    TEXT    NOT NULL,
                expires INTEGER NOT NULL
            )
        `);

        // Prune expired rows every 10 minutes so the table doesn't grow forever.
        this._pruneInterval = setInterval(() => {
            db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
        }, 10 * 60 * 1000).unref(); // .unref() so it doesn't block process exit
    }

    get(sid, cb) {
        try {
            const row = this._db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
            if (!row) return cb(null, null);
            if (row.expires < Date.now()) {
                this.destroy(sid, () => {});
                return cb(null, null);
            }
            cb(null, JSON.parse(row.data));
        } catch (e) { cb(e); }
    }

    set(sid, sessionData, cb) {
        try {
            const maxAge  = sessionData.cookie?.maxAge || 7 * 24 * 60 * 60 * 1000;
            const expires = Date.now() + maxAge;
            this._db.prepare(`
                INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
                ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires
            `).run(sid, JSON.stringify(sessionData), expires);
            cb(null);
        } catch (e) { cb(e); }
    }

    destroy(sid, cb) {
        try {
            this._db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
            cb(null);
        } catch (e) { cb(e); }
    }
}

module.exports = SQLiteStore;
