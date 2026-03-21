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
for (const col of ['selected_db_id TEXT', 'selected_db_name TEXT', 'client_token TEXT']) {
    try { db.exec(`ALTER TABLE notion_tokens ADD COLUMN ${col}`); } catch { /* column already exists */ }
}

// Short-lived table for relaying the client token from a popup back to the embed.
// The embed polls /api/auth/poll?key=EMBEDKEY after opening the OAuth popup.
// Rows are cleaned up on read or after 5 minutes.
db.exec(`
    CREATE TABLE IF NOT EXISTS pending_auth (
        embed_key  TEXT    PRIMARY KEY,
        session_id TEXT    NOT NULL,
        created_at INTEGER NOT NULL
    )
`);

// Persistent timer/history state keyed by Notion workspace_id.
// Using workspace_id (not session_id) means the data survives re-authentication.
db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
        workspace_id TEXT    PRIMARY KEY,
        state_json   TEXT    NOT NULL,
        updated_at   INTEGER NOT NULL
    )
`);

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

/**
 * Save a random client token for the given session.
 * This token is sent by the frontend as a Bearer header instead of relying
 * on cross-site cookies, making auth work inside Notion iframes.
 */
function saveClientToken(sessionId, clientToken) {
    db.prepare(`UPDATE notion_tokens SET client_token = ?, updated_at = ? WHERE session_id = ?`)
      .run(clientToken, Date.now(), sessionId);
}

/**
 * Look up a token row by client token.  Returns null if not found.
 */
function getTokenByClientToken(clientToken) {
    return db.prepare('SELECT * FROM notion_tokens WHERE client_token = ?').get(clientToken) || null;
}

/**
 * Store a short-lived mapping from embedKey → sessionId.
 * Used to relay the client token from an OAuth popup to the waiting embed.
 */
function savePendingAuth(embedKey, sessionId) {
    db.prepare(`INSERT OR REPLACE INTO pending_auth (embed_key, session_id, created_at) VALUES (?, ?, ?)`)
      .run(embedKey, sessionId, Date.now());
}

/**
 * Look up and immediately remove a pending auth entry.
 * Also prunes entries older than 5 minutes.
 * Returns the matching token row, or null.
 */
function consumePendingAuth(embedKey) {
    db.prepare('DELETE FROM pending_auth WHERE created_at < ?').run(Date.now() - 5 * 60 * 1000);
    const row = db.prepare('SELECT session_id FROM pending_auth WHERE embed_key = ?').get(embedKey);
    if (!row) return null;
    db.prepare('DELETE FROM pending_auth WHERE embed_key = ?').run(embedKey);
    return getToken(row.session_id);
}

/**
 * Upsert the durable timer/history state for a Notion workspace.
 * @param {string} workspaceId — Notion workspace UUID
 * @param {string} stateJson   — JSON-stringified { goalMins, history, bestStreak }
 */
function saveAppState(workspaceId, stateJson) {
    db.prepare(`
        INSERT INTO app_state (workspace_id, state_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
            state_json = excluded.state_json,
            updated_at = excluded.updated_at
    `).run(workspaceId, stateJson, Date.now());
}

/**
 * Retrieve the durable state for a workspace, or null if not found.
 * @param {string} workspaceId
 * @returns {{ state_json: string, updated_at: number } | null}
 */
function getAppState(workspaceId) {
    return db.prepare('SELECT state_json, updated_at FROM app_state WHERE workspace_id = ?').get(workspaceId) || null;
}

/** Graceful shutdown — lets the process exit cleanly. */
function close() {
    db.close();
}

module.exports = { db, saveToken, getToken, deleteToken, saveSelectedDb, saveClientToken, getTokenByClientToken, savePendingAuth, consumePendingAuth, saveAppState, getAppState, close };
