'use strict';
/**
 * Notion database routes
 *
 *   GET  /api/databases         — list databases accessible to this session's token
 *   POST /api/databases/select  — save the user's chosen database
 */

const router      = require('express').Router();
const requireAuth = require('../middleware/auth');
const { saveSelectedDb } = require('../db');

// ── GET /api/databases ────────────────────────────────────
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
                filter:    { value: 'database', property: 'object' },
                sort:      { direction: 'descending', timestamp: 'last_edited_time' },
                page_size: 50,
            }),
        });

        const data = await notionRes.json();

        if (!notionRes.ok) {
            if (notionRes.status === 401) {
                return res.status(401).json({ error: 'Notion token expired — please reconnect' });
            }
            console.error('Notion search error — status:', notionRes.status, 'code:', data?.code);
            return res.status(502).json({
                error: data?.message || `Notion API error (HTTP ${notionRes.status})`,
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
        console.error('Failed to fetch Notion databases:', err.message);
        res.status(502).json({ error: 'Could not reach Notion — check your connection and try again' });
    }
});

// ── POST /api/databases/select ────────────────────────────
router.post('/select', requireAuth, (req, res) => {
    const { dbId, dbName } = req.body || {};

    if (typeof dbId !== 'string' || !dbId.trim()) {
        return res.status(400).json({ error: 'dbId is required' });
    }

    saveSelectedDb(req.resolvedSessionId, dbId.trim(), (dbName || '').trim() || 'Untitled');
    res.json({ ok: true });
});

// ── Helpers ───────────────────────────────────────────────

function richTextToPlain(arr) {
    if (!Array.isArray(arr)) return '';
    return arr.map(t => t.plain_text || '').join('').trim();
}

function iconToString(icon) {
    if (!icon) return null;
    if (icon.type === 'emoji') return icon.emoji;
    return null;
}

module.exports = router;
