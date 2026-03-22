'use strict';
/**
 * SQLite persistence layer.
 *
 * Schema overview:
 *   notion_tokens      — Notion OAuth tokens, keyed by express session_id
 *   pending_auth       — short-lived embed-poll relay (popup → iframe)
 *   sessions           — express-session storage (via session-store.js)
 *   user_state         — canonical timer/history data, keyed by owner_id
 *                        owner_type = 'guest'  → guest_id (UUID generated client-side)
 *                        owner_type = 'notion' → Notion workspace_id
 *   guest_notion_links — links a guest_id to a workspace_id after OAuth
 *                        used to migrate guest data when a guest connects Notion
 *
 * PRODUCTION NOTE:
 *   Access tokens are stored in plaintext.  Before going to production,
 *   encrypt the `access_token` column using AES-256-GCM with a key derived
 *   from an environment variable (e.g. TOKEN_ENCRYPTION_KEY).
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
db.exec(`
    CREATE TABLE IF NOT EXISTS pending_auth (
        embed_key  TEXT    PRIMARY KEY,
        session_id TEXT    NOT NULL,
        created_at INTEGER NOT NULL
    )
`);

// Canonical timer/history state.
// owner_type is either 'guest' (anonymous UUID) or 'notion' (Notion workspace_id).
// Keyed by owner_id so data survives re-authentication and is shared across
// all sessions that belong to the same identity.
db.exec(`
    CREATE TABLE IF NOT EXISTS user_state (
        owner_id   TEXT    PRIMARY KEY,
        owner_type TEXT    NOT NULL,
        state_json TEXT    NOT NULL,
        updated_at INTEGER NOT NULL
    )
`);

// Links a guest_id to a workspace_id after the guest connects Notion.
// Used to merge guest data into the Notion account (one-time migration).
db.exec(`
    CREATE TABLE IF NOT EXISTS guest_notion_links (
        guest_id     TEXT    PRIMARY KEY,
        workspace_id TEXT    NOT NULL,
        linked_at    INTEGER NOT NULL
    )
`);

// Email/password accounts (owner_type = 'app' in user_state).
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL
    )
`);

// Time-limited password reset tokens (expire after 1 hour, single-use).
db.exec(`
    CREATE TABLE IF NOT EXISTS reset_tokens (
        token      TEXT    PRIMARY KEY,
        user_id    TEXT    NOT NULL,
        expires_at INTEGER NOT NULL,
        used       INTEGER NOT NULL DEFAULT 0
    )
`);

// One-time migration: promote rows from the old app_state table (keyed by workspace_id)
// into user_state so no data is lost after the schema upgrade.
try {
    const old = db.prepare('SELECT workspace_id, state_json, updated_at FROM app_state').all();
    const ins  = db.prepare(`
        INSERT OR IGNORE INTO user_state (owner_id, owner_type, state_json, updated_at)
        VALUES (?, 'notion', ?, ?)
    `);
    const migrate = db.transaction(() => { for (const r of old) ins.run(r.workspace_id, r.state_json, r.updated_at); });
    if (old.length) { migrate(); console.log(`Migrated ${old.length} row(s) from app_state → user_state`); }
} catch { /* app_state table may not exist; safe to ignore */ }

// ── Public API ────────────────────────────────────────────

/**
 * Upsert a token row for the given session.
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

function getToken(sessionId) {
    return db.prepare('SELECT * FROM notion_tokens WHERE session_id = ?').get(sessionId) || null;
}

function deleteToken(sessionId) {
    db.prepare('DELETE FROM notion_tokens WHERE session_id = ?').run(sessionId);
}

function saveSelectedDb(sessionId, dbId, dbName) {
    db.prepare(`
        UPDATE notion_tokens
        SET selected_db_id = ?, selected_db_name = ?, updated_at = ?
        WHERE session_id = ?
    `).run(dbId, dbName, Date.now(), sessionId);
}

function saveClientToken(sessionId, clientToken) {
    db.prepare(`UPDATE notion_tokens SET client_token = ?, updated_at = ? WHERE session_id = ?`)
      .run(clientToken, Date.now(), sessionId);
}

function getTokenByClientToken(clientToken) {
    return db.prepare('SELECT * FROM notion_tokens WHERE client_token = ?').get(clientToken) || null;
}

function savePendingAuth(embedKey, sessionId) {
    db.prepare(`INSERT OR REPLACE INTO pending_auth (embed_key, session_id, created_at) VALUES (?, ?, ?)`)
      .run(embedKey, sessionId, Date.now());
}

function consumePendingAuth(embedKey) {
    db.prepare('DELETE FROM pending_auth WHERE created_at < ?').run(Date.now() - 5 * 60 * 1000);
    const row = db.prepare('SELECT session_id FROM pending_auth WHERE embed_key = ?').get(embedKey);
    if (!row) return null;
    db.prepare('DELETE FROM pending_auth WHERE embed_key = ?').run(embedKey);
    return getToken(row.session_id);
}

// ── User state (canonical persistence) ────────────────────

/**
 * Upsert the durable timer state for any owner (guest or Notion workspace).
 * @param {string} ownerId    — guest UUID or Notion workspace_id
 * @param {'guest'|'notion'} ownerType
 * @param {string} stateJson  — JSON { goalMins, history, bestStreak }
 */
function saveUserState(ownerId, ownerType, stateJson) {
    db.prepare(`
        INSERT INTO user_state (owner_id, owner_type, state_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET
            state_json = excluded.state_json,
            updated_at = excluded.updated_at
    `).run(ownerId, ownerType, stateJson, Date.now());
}

/**
 * Retrieve user state by owner_id.  Returns null if not found.
 * @param {string} ownerId
 * @returns {{ owner_id, owner_type, state_json, updated_at } | null}
 */
function getUserState(ownerId) {
    return db.prepare('SELECT * FROM user_state WHERE owner_id = ?').get(ownerId) || null;
}

// ── Guest → Notion migration ───────────────────────────────

/**
 * Called when a guest user completes Notion OAuth.
 * Merges the guest's history into the workspace state (workspace wins on conflicts),
 * then records the guest→workspace link so future guest requests can be forwarded.
 *
 * Safe to call multiple times — the link is idempotent (INSERT OR REPLACE).
 *
 * @param {string} guestId
 * @param {string} workspaceId
 */
function migrateGuestToNotion(guestId, workspaceId) {
    if (!guestId || !workspaceId) return;

    // Record the link (idempotent).
    db.prepare(`
        INSERT OR REPLACE INTO guest_notion_links (guest_id, workspace_id, linked_at)
        VALUES (?, ?, ?)
    `).run(guestId, workspaceId, Date.now());

    // Pull guest state.
    const guestRow = getUserState(guestId);
    if (!guestRow) return; // nothing to migrate

    let guestState;
    try { guestState = JSON.parse(guestRow.state_json); } catch { return; }

    // Pull or initialise workspace state.
    const wsRow = getUserState(workspaceId);
    let wsState = { goalMins: 120, history: {}, bestStreak: 0 };
    if (wsRow) {
        try { wsState = JSON.parse(wsRow.state_json); } catch { /* keep defaults */ }
    }

    // Merge: workspace wins for entries that exist in both; guest fills in the rest.
    const mergedHistory = { ...guestState.history, ...wsState.history };
    const merged = {
        goalMins:   wsState.goalMins || guestState.goalMins || 120,
        history:    mergedHistory,
        bestStreak: Math.max(wsState.bestStreak || 0, guestState.bestStreak || 0),
    };

    saveUserState(workspaceId, 'notion', JSON.stringify(merged));
    console.log(`Migrated guest ${guestId.slice(0, 8)}… → workspace ${workspaceId}`);
}

/**
 * Return the workspace_id linked to this guest_id, or null.
 * Used to forward a returning guest to their Notion account if they've already linked.
 */
function getWorkspaceForGuest(guestId) {
    const row = db.prepare('SELECT workspace_id FROM guest_notion_links WHERE guest_id = ?').get(guestId);
    return row ? row.workspace_id : null;
}

// ── App user accounts ──────────────────────────────────────

function createUser(id, email, passwordHash) {
    db.prepare(`
        INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)
    `).run(id, email, passwordHash, Date.now());
    return getUserById(id);
}

function getUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

function getUserById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

/**
 * Merge a guest's history into an app-user account when they sign up or log in.
 * App-user state wins on date conflicts; guest fills in missing dates.
 */
function migrateGuestToApp(guestId, userId) {
    if (!guestId || !userId) return;

    const guestRow = getUserState(guestId);
    if (!guestRow) return;

    let guestState;
    try { guestState = JSON.parse(guestRow.state_json); } catch { return; }

    const appRow = getUserState(userId);
    let appState = { goalMins: 120, history: {}, bestStreak: 0 };
    if (appRow) {
        try { appState = JSON.parse(appRow.state_json); } catch { /* keep defaults */ }
    }

    const mergedHistory = { ...guestState.history, ...appState.history };
    const merged = {
        goalMins:   appState.goalMins || guestState.goalMins || 120,
        history:    mergedHistory,
        bestStreak: Math.max(appState.bestStreak || 0, guestState.bestStreak || 0),
    };

    saveUserState(userId, 'app', JSON.stringify(merged));
    console.log(`Migrated guest ${guestId.slice(0, 8)}… → app user ${userId.slice(0, 8)}…`);
}

// ── Password reset tokens ──────────────────────────────────

function createResetToken(token, userId) {
    const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour
    db.prepare(`
        INSERT OR REPLACE INTO reset_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)
    `).run(token, userId, expiresAt);
}

function getResetToken(token) {
    return db.prepare('SELECT * FROM reset_tokens WHERE token = ?').get(token) || null;
}

function markResetTokenUsed(token) {
    db.prepare('UPDATE reset_tokens SET used = 1 WHERE token = ?').run(token);
}

function updateUserPassword(userId, passwordHash) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}

/** Graceful shutdown. */
function close() {
    db.close();
}

module.exports = {
    db,
    saveToken, getToken, deleteToken, saveSelectedDb,
    saveClientToken, getTokenByClientToken,
    savePendingAuth, consumePendingAuth,
    saveUserState, getUserState,
    migrateGuestToNotion, getWorkspaceForGuest,
    createUser, getUserByEmail, getUserById, migrateGuestToApp,
    createResetToken, getResetToken, markResetTokenUsed, updateUserPassword,
    close,
};
