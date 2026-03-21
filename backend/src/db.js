'use strict';
/**
 * SQLite persistence layer.
 *
 * Chosen for zero-config local dev.  To upgrade to Postgres later, replace
 * this module with a pg-based equivalent that exposes the same four exports
 * (saveToken, getToken, deleteToken, close) — nothing else in the codebase
 * needs to change.
 *
 * PRODUCTION NOTE:
 *   Access tokens are stored in plaintext.  Before going to production,
 *   encrypt the `access_token` column using AES-256-GCM with a key derived
 *   from an environment variable (e.g. TOKEN_ENCRYPTION_KEY).
 *   The rest of the schema can stay as-is.
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// DATA_PATH can be set to a persistent disk mount point on hosting platforms
// (e.g. /var/data on Render). Falls back to backend/data/ for local dev.
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'focusup.db'));

// WAL mode gives better concurrent read performance and atomic writes.
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS notion_tokens (
        session_id       TEXT    PRIMARY KEY,
        access_token     TEXT    NOT NULL,
        workspace_id     TEXT,
        workspace_name   TEXT,
        workspace_icon   TEXT,
        bot_id           TEXT,
        owner_type       TEXT,
        selected_db_id   TEXT,
        selected_db_name TEXT,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
    )
`);

// Migration: add columns that may be missing in databases created before this version.
for (const col of ['selected_db_id TEXT', 'selected_db_name TEXT']) {
    try { db.exec(`ALTER TABLE notion_tokens ADD COLUMN ${col}`); } catch { /* column already exists */ }
}

// ── Public API ────────────────────────────────────────────

/**
 * Upsert a token row for the given session.
 * @param {string} sessionId  - express-session req.session.id
 * @param {object} tokenData  - raw response body from Notion /oauth/token
 */
function saveToken(sessionId, tokenData) {
    const now = Date.now();
    db.prepare(`
        INSERT INTO notion_tokens
            (session_id, access_token, workspace_id, workspace_name, workspace_icon, bot_id, owner_type, created_at, updated_at)
        VALUES
            (@sessionId, @access_token, @workspace_id, @workspace_name, @workspace_icon, @bot_id, @owner_type, @now, @now)
        ON CONFLICT(session_id) DO UPDATE SET
            access_token   = excluded.access_token,
            workspace_id   = excluded.workspace_id,
            workspace_name = excluded.workspace_name,
            workspace_icon = excluded.workspace_icon,
            bot_id         = excluded.bot_id,
            owner_type     = excluded.owner_type,
            updated_at     = excluded.updated_at
    `).run({
        sessionId,
        access_token:   tokenData.access_token,
        workspace_id:   tokenData.workspace_id   || null,
        workspace_name: tokenData.workspace_name || null,
        workspace_icon: tokenData.workspace_icon || null,
        bot_id:         tokenData.bot_id         || null,
        owner_type:     tokenData.owner?.type    || null,
        now,
    });
}

/**
 * Retrieve a token row by session ID.  Returns null if not found.
 * @param {string} sessionId
 * @returns {{ access_token, workspace_id, workspace_name, ... } | null}
 */
function getToken(sessionId) {
    return db.prepare('SELECT * FROM notion_tokens WHERE session_id = ?').get(sessionId) || null;
}

/**
 * Remove a token row (called on disconnect / logout).
 * @param {string} sessionId
 */
function deleteToken(sessionId) {
    db.prepare('DELETE FROM notion_tokens WHERE session_id = ?').run(sessionId);
}

/**
 * Persist the user's chosen Notion database.
 * @param {string} sessionId
 * @param {string} dbId   — Notion database UUID
 * @param {string} dbName — human-readable title
 */
function saveSelectedDb(sessionId, dbId, dbName) {
    db.prepare(`
        UPDATE notion_tokens
        SET selected_db_id = ?, selected_db_name = ?, updated_at = ?
        WHERE session_id = ?
    `).run(dbId, dbName, Date.now(), sessionId);
}

/** Graceful shutdown — lets the process exit cleanly. */
function close() {
    db.close();
}

module.exports = { db, saveToken, getToken, deleteToken, saveSelectedDb, close };
