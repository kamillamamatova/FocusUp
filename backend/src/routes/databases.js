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
    const headers = {
        'Authorization':  `Bearer ${req.notionToken}`,
        'Notion-Version': '2022-06-28',
        'Content-Type':   'application/json',
    };

    try {
        // Paginate through all accessible databases (Notion caps each page at 100).
        const allResults = [];
        let cursor = undefined;

        do {
            const body = {
                filter:    { value: 'database', property: 'object' },
                sort:      { direction: 'descending', timestamp: 'last_edited_time' },
                page_size: 100,
            };
            if (cursor) body.start_cursor = cursor;

            const notionRes = await fetch('https://api.notion.com/v1/search', {
                method: 'POST',
                headers,
                body:   JSON.stringify(body),
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

            allResults.push(...(data.results || []));
            cursor = data.has_more ? data.next_cursor : null;
        } while (cursor);

        // Diagnostic log — shows exactly what Notion returned so you can confirm
        // which databases the integration currently has access to.
        console.log(`Notion search returned ${allResults.length} database(s) total:`);
        for (const db of allResults) {
            console.log(`  id=${db.id}  title=${JSON.stringify(db.title)}  parent=${JSON.stringify(db.parent)}  url=${db.url}`);
        }

        // For each database, try to resolve the parent page title so inline/
        // untitled databases can be identified as "Database in [Page Name]".
        const databases = await Promise.all(allResults.map(async db => {
            const name = await resolvedName(db, headers);
            return {
                id:   db.id,
                name,
                icon: iconToString(db.icon),
                url:  db.url || null,
            };
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
 * Resolve a human-readable name for a database, making an extra API call to
 * fetch the parent page title when the database itself has no name.
 *
 * Resolution order:
 *   1. db.title rich-text array (set when you type a name in the database header)
 *   2. URL slug (Notion encodes the title before the 32-char ID in the URL)
 *   3. Parent page title (for inline/untitled databases — "Database in <Page>")
 *   4. "Untitled" — last resort
 */
async function resolvedName(db, headers) {
    // 1. Explicit title field
    const fromTitle = richTextToPlain(db.title);
    if (fromTitle) return fromTitle;

    // 2. Slug extracted from the Notion URL
    const fromUrl = urlSlugToName(db.url);
    if (fromUrl) return fromUrl;

    // 3. Try to name the database by its parent page title.
    //    Inline databases have parent.type === 'page_id'.
    //    This requires one extra API call per unnamed database.
    const parentPageId = db.parent?.type === 'page_id' ? db.parent.page_id : null;
    if (parentPageId) {
        try {
            const pageRes = await fetch(`https://api.notion.com/v1/pages/${parentPageId}`, { headers });
            if (pageRes.ok) {
                const page = await pageRes.json();
                // Page titles live in properties.title (most pages) or the Name property.
                const titleProp = page.properties?.title || page.properties?.Name;
                const pageTitle = richTextToPlain(titleProp?.title);
                if (pageTitle) return `Database in "${pageTitle}"`;
            }
        } catch {
            // Non-fatal — fall through to 'Untitled'
        }
    }

    return 'Untitled';
}

/** Synchronous name extraction (title + URL slug only, no API call). */
function databaseName(db) {
    const fromTitle = richTextToPlain(db.title);
    if (fromTitle) return fromTitle;
    return urlSlugToName(db.url) || 'Untitled';
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
