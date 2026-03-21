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

        // Diagnostic: log the raw title/icon/url for each result so the server log
        // shows exactly what Notion returned for each database.
        console.log(`Notion search returned ${(data.results || []).length} database(s):`);
        for (const db of (data.results || [])) {
            console.log(`  id=${db.id}  title=${JSON.stringify(db.title)}  icon=${JSON.stringify(db.icon)}  url=${db.url}`);
        }

        const databases = (data.results || []).map(db => ({
            id:   db.id,
            name: databaseName(db),
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

/**
 * Extract a human-readable name for a database object.
 *
 * Resolution order:
 *   1. db.title array (the page-level header title — set when you type a name
 *      in the big heading area at the top of the database page in Notion)
 *   2. URL slug — Notion encodes the title in the URL path before the 32-char ID;
 *      e.g. ".../My-Focus-Log-abc123..." → "My Focus Log"
 *      Useful when db.title is empty but the database has a visible name in Notion.
 *   3. "Untitled" — last resort fallback
 */
function databaseName(db) {
    // 1. Explicit title field
    const fromTitle = richTextToPlain(db.title);
    if (fromTitle) return fromTitle;

    // 2. Slug extracted from the Notion URL
    const fromUrl = urlSlugToName(db.url);
    if (fromUrl) return fromUrl;

    return 'Untitled';
}

function richTextToPlain(arr) {
    if (!Array.isArray(arr)) return '';
    return arr.map(t => t.plain_text || '').join('').trim();
}

/**
 * Extract a readable name from a Notion URL.
 * Notion URLs look like: https://www.notion.so/workspace/My-Database-Name-<32hexchars>
 * The last path segment is "<title-slug>-<id>" — we strip the trailing ID.
 */
function urlSlugToName(url) {
    if (!url) return '';
    try {
        const segment = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
        // Remove the trailing 32-character hex ID (with or without a preceding dash).
        const slug = segment.replace(/-?[0-9a-f]{32}$/i, '').replace(/-/g, ' ').trim();
        return slug || '';
    } catch {
        return '';
    }
}

/**
 * Return a displayable icon string for a database.
 * Notion icon types:
 *   'emoji'    — plain emoji character, use directly
 *   'external' — remote image URL; render as generic icon in the UI
 *   'file'     — Notion-hosted image; render as generic icon in the UI
 */
function iconToString(icon) {
    if (!icon) return null;
    if (icon.type === 'emoji') return icon.emoji;
    // External/file icons are image URLs — return a marker so the UI can
    // show a generic placeholder instead of the invisible fallback book emoji.
    if (icon.type === 'external' || icon.type === 'file') return '__image__';
    return null;
}

module.exports = router;
