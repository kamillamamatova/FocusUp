'use strict';
/**
 * identifyUser middleware — resolves any supported identity for the /api/state routes.
 *
 * Resolution order (first match wins):
 *   1. Authorization: Bearer <clientToken>  — Notion-connected user (iframe-safe)
 *   2. Session cookie                       — Notion-connected user (browser tab fallback)
 *   3. X-Guest-ID: <guestId>               — anonymous guest with a locally-generated UUID
 *
 * On success, sets:
 *   req.ownerId    — the canonical persistence key (workspace_id or guest UUID)
 *   req.ownerType  — 'notion' | 'guest'
 *
 * Notion paths also set req.notionToken, req.tokenRow, req.resolvedSessionId
 * (same as requireAuth) so Notion-specific code can rely on those too.
 *
 * On failure, returns 401.
 */

const { getToken, getTokenByClientToken } = require('../db');

// Guest UUIDs are hex strings (with optional hyphens) of 32–64 characters.
const GUEST_ID_RE = /^[0-9a-f-]{32,64}$/i;

module.exports = function identifyUser(req, res, next) {
    // ── 1. Bearer token (Notion, iframe-safe) ─────────────
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
        const clientToken = authHeader.slice(7).trim();
        if (clientToken) {
            const row = getTokenByClientToken(clientToken);
            if (row && row.workspace_id) {
                req.ownerId           = row.workspace_id;
                req.ownerType         = 'notion';
                req.notionToken       = row.access_token;
                req.tokenRow          = row;
                req.resolvedSessionId = row.session_id;
                return next();
            }
        }
    }

    // ── 2. Session cookie (Notion, browser tab fallback) ──
    if (req.session?.connected) {
        const row = getToken(req.session.id);
        if (row && row.workspace_id) {
            req.ownerId           = row.workspace_id;
            req.ownerType         = 'notion';
            req.notionToken       = row.access_token;
            req.tokenRow          = row;
            req.resolvedSessionId = req.session.id;
            return next();
        }
        req.session.connected = false; // stale flag — clear it
    }

    // ── 3. Guest ID header ─────────────────────────────────
    const guestId = (req.headers['x-guest-id'] || '').trim();
    if (guestId && GUEST_ID_RE.test(guestId)) {
        req.ownerId   = guestId;
        req.ownerType = 'guest';
        return next();
    }

    return res.status(401).json({
        error: 'Provide a Notion connection (Authorization: Bearer) or a guest identity (X-Guest-ID)',
    });
};
