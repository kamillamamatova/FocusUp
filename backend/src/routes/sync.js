'use strict';
/**
 * POST /api/sync
 *
 * Writes (or updates) a finished-day entry in the user's selected Notion database.
 *
 * Idempotency: before creating, we query the database for an existing page
 * whose Date property matches the given date.  If one exists we PATCH it
 * instead of creating a duplicate.  Safe to call multiple times for the
 * same day.
 *
 * Expected request body:
 *   { date: "YYYY-MM-DD", minutes: number, goal: number, met: boolean }
 */

const router    = require('express').Router();
const { getToken } = require('../db');

const NOTION_VERSION = '2022-06-28';

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
    if (!row.selected_db_id) {
        return res.status(400).json({ error: 'No Notion database selected — choose one in the Notion Sync panel' });
    }
    req.notionToken = row.access_token;
    req.dbId        = row.selected_db_id;
    next();
}

// ── POST /api/sync ────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
    const { date, minutes, goal, met } = req.body || {};

    // Validate shape
    if (
        typeof date    !== 'string'  || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        typeof minutes !== 'number'  || minutes < 0  ||
        typeof goal    !== 'number'  || goal    < 1  ||
        typeof met     !== 'boolean'
    ) {
        return res.status(400).json({
            error:    'Invalid request body',
            expected: { date: 'YYYY-MM-DD', minutes: 'number ≥ 0', goal: 'number ≥ 1', met: 'boolean' },
        });
    }

    const headers = {
        'Authorization':  `Bearer ${req.notionToken}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type':   'application/json',
    };

    const properties = {
        'Date':    { date:     { start: date } },
        'Minutes': { number:   minutes        },
        'Goal':    { number:   goal           },
        'Met':     { checkbox: met            },
    };

    try {
        // ── Check for an existing page with the same date (idempotency) ──
        const existing = await findExistingPage(req.notionToken, req.dbId, date, headers);

        let notionRes, action;
        if (existing) {
            // Update the existing page instead of creating a duplicate.
            notionRes = await fetch(`https://api.notion.com/v1/pages/${existing}`, {
                method:  'PATCH',
                headers,
                body:    JSON.stringify({ properties }),
            });
            action = 'updated';
        } else {
            notionRes = await fetch('https://api.notion.com/v1/pages', {
                method:  'POST',
                headers,
                body:    JSON.stringify({ parent: { database_id: req.dbId }, properties }),
            });
            action = 'created';
        }

        const body = await notionRes.json();

        if (!notionRes.ok) {
            return res.status(502).json({ error: notionErrorMessage(notionRes.status, body) });
        }

        return res.json({ ok: true, action, pageId: body.id });

    } catch (err) {
        console.error('Sync error:', err);
        return res.status(502).json({ error: 'Could not reach Notion — check your connection' });
    }
});

// ── Helpers ───────────────────────────────────────────────

/**
 * Query the database for a page whose Date property equals `date`.
 * Returns the page ID string if found, null otherwise.
 */
async function findExistingPage(token, dbId, date, headers) {
    try {
        const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
            method:  'POST',
            headers,
            body:    JSON.stringify({
                filter:    { property: 'Date', date: { equals: date } },
                page_size: 1,
            }),
        });
        if (!res.ok) return null; // treat query failure as "not found" — write will surface the real error
        const data = await res.json();
        return data.results?.[0]?.id || null;
    } catch {
        return null;
    }
}

/**
 * Map Notion API error responses to user-readable messages.
 */
function notionErrorMessage(status, body) {
    if (status === 401) {
        return 'Notion token expired — please disconnect and reconnect';
    }
    if (status === 404) {
        return 'Database not found — it may have been deleted or access was revoked. Choose a different database.';
    }
    if (status === 400) {
        const msg = (body?.message || '').toLowerCase();
        if (msg.includes('property') || msg.includes('validation_error') || body?.code === 'validation_error') {
            return 'Property mismatch — make sure your database has columns named Date (date), Minutes (number), Goal (number), and Met (checkbox)';
        }
        return `Notion rejected the request: ${body?.message || 'bad request'}`;
    }
    if (status === 429) {
        return 'Notion rate limit reached — please try again in a moment';
    }
    return `Notion error (HTTP ${status}): ${body?.message || 'unknown error'}`;
}

module.exports = router;
