'use strict';
/**
 * Shared requireAuth middleware.
 *
 * Checks that:
 *   1. The session has a `connected` flag (set after successful OAuth).
 *   2. A token row actually exists in the DB for this session (guards against
 *      orphaned sessions where the cookie outlives the DB record).
 *
 * On success, attaches `req.notionToken` and `req.tokenRow` for downstream use.
 * Routes that need `selected_db_id` should check `req.tokenRow.selected_db_id`
 * themselves after this middleware runs.
 */

const { getToken } = require('../db');

module.exports = function requireAuth(req, res, next) {
    if (!req.session?.connected) {
        return res.status(401).json({ error: 'Not authenticated — connect Notion first' });
    }

    const row = getToken(req.session.id);
    if (!row) {
        // Session cookie exists but the DB record was deleted (e.g. manual cleanup).
        // Clear the stale flag so subsequent /status calls return connected:false.
        req.session.connected = false;
        return res.status(401).json({ error: 'Session expired — please reconnect Notion' });
    }

    req.notionToken = row.access_token;
    req.tokenRow    = row;
    next();
};
