'use strict';
/**
 * Notion database routes
 *
 *   GET  /api/databases         — list databases accessible to this session's token
 *   POST /api/databases/select  — save the user's chosen database
 *
 * Both routes require an authenticated session (Notion token present in DB).
 */

const router = require('express').Router();
const { getToken, saveSelectedDb } = require('../db');

// ── Auth guard ────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (!req.session?.connected) {
        return res.status(401).json({ error: 'Not authenticated — connect Notion first' });
    }
    const row = getToken(req.session.id);
    if (!row) {
        req.session.connected = false;
        return res.status(401).json({ error: 'Session expired — please reconnect Notion' });
    }
    req.notionToken = row.access_token;
    req.tokenRow    = row;
    next();
}

// ── GET /api/databases ────────────────────────────────────
// Uses the Notion Search API to list databases the user shared with the integration.
// Notion only returns objects explicitly granted during OAuth — not all workspace content.
router.get('/', requireAuth, async (req, res) => {
    try {
        const notionRes = await fetch('https://api.notion.com/v1/search', {
            method: 'POST',
            headers: {
                'Authorization':  `Bearer ${req.notionToken}`,
                'Notion-Version': '2022-06-28',
                'Content-Type':   'application/json',
            },
            body: JSON.stringify({
                filter: { value: 'database', property: 'object' },
                sort:   { direction: 'descending', timestamp: 'last_edited_time' },
                page_size: 50,
            }),
        });

        const data = await notionRes.json();

        if (!notionRes.ok) {
            if (notionRes.status === 401) {
                return res.status(401).json({ error: 'Notion token expired — please reconnect' });
            }
            console.error('Notion search error:', data);
            return res.status(502).json({
                error: data.message || `Notion API error (HTTP ${notionRes.status})`,
            });
        }

        const databases = (data.results || []).map(db => ({
            id:   db.id,
            name: richTextToPlain(db.title) || 'Untitled',
            icon: iconToString(db.icon),
            url:  db.url || null,
        }));

        res.json({ databases });
    } catch (err) {
        console.error('Failed to fetch Notion databases:', err);
        res.status(502).json({ error: 'Could not reach Notion — check your connection and try again' });
    }
});

// ── POST /api/databases/select ────────────────────────────
router.post('/select', requireAuth, (req, res) => {
    const { dbId, dbName } = req.body || {};

    if (typeof dbId !== 'string' || !dbId.trim()) {
        return res.status(400).json({ error: 'dbId is required' });
    }

    saveSelectedDb(req.session.id, dbId.trim(), (dbName || '').trim() || 'Untitled');
    res.json({ ok: true });
});

// ── Helpers ───────────────────────────────────────────────

/** Flatten a Notion rich_text / title array to a plain string. */
function richTextToPlain(arr) {
    if (!Array.isArray(arr)) return '';
    return arr.map(t => t.plain_text || '').join('').trim();
}

/** Return a single emoji or null from a Notion icon object. */
function iconToString(icon) {
    if (!icon) return null;
    if (icon.type === 'emoji') return icon.emoji;
    return null;
}

module.exports = router;
