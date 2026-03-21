'use strict';
/**
 * Shared requireAuth middleware.
 *
 * Accepts two auth methods (checked in order):
 *   1. Bearer token  — sent as `Authorization: Bearer <clientToken>` header.
 *      Works in cross-origin contexts (Notion iframes) where session cookies
 *      are blocked by browser third-party cookie restrictions.
 *   2. Session cookie — legacy fallback for existing browser-tab sessions.
 *
 * On success, attaches to the request:
 *   req.notionToken       — Notion access token
 *   req.tokenRow          — full DB row
 *   req.resolvedSessionId — session_id from the DB row (use instead of req.session.id)
 */

const { getToken, getTokenByClientToken } = require('../db');

module.exports = function requireAuth(req, res, next) {
    // ── 1. Bearer token (iframe-safe) ─────────────────────
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
        const clientToken = authHeader.slice(7).trim();
        if (clientToken) {
            const row = getTokenByClientToken(clientToken);
            if (row) {
                req.notionToken       = row.access_token;
                req.tokenRow          = row;
                req.resolvedSessionId = row.session_id;
                return next();
            }
        }
    }

    // ── 2. Session cookie (browser tab fallback) ───────────
    if (req.session?.connected) {
        const row = getToken(req.session.id);
        if (row) {
            req.notionToken       = row.access_token;
            req.tokenRow          = row;
            req.resolvedSessionId = req.session.id;
            return next();
        }
        // Session cookie exists but DB record is gone — clear stale flag.
        req.session.connected = false;
    }

    return res.status(401).json({ error: 'Not authenticated — connect Notion first' });
};
