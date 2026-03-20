'use strict';
/**
 * POST /api/sync
 *
 * Writes (or updates) a finished-day entry in the user's selected Notion database.
 *
 * Idempotency: before creating, we query the database for an existing page
 * whose Date property matches the given date.  If one exists we PATCH it
 * instead of creating a duplicate.  Safe to call multiple times for the same day.
 *
 * Expected request body:
 *   { date: "YYYY-MM-DD", minutes: number, goal: number, met: boolean }
 */

const router      = require('express').Router();
const requireAuth = require('../middleware/auth');

const NOTION_VERSION = '2022-06-28';

// ── POST /api/sync ────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
    // Ensure the user has already selected a target database.
    const dbId = req.tokenRow.selected_db_id;
    if (!dbId) {
        return res.status(400).json({
            error: 'No Notion database selected — choose one in the Notion Sync panel',
        });
    }

    const { date, minutes, goal, met } = req.body || {};

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
        const existingId = await findExistingPage(req.notionToken, dbId, date, headers);

        let notionRes, action;
        if (existingId) {
            notionRes = await fetch(`https://api.notion.com/v1/pages/${existingId}`, {
                method: 'PATCH',
                headers,
                body:   JSON.stringify({ properties }),
            });
            action = 'updated';
        } else {
            notionRes = await fetch('https://api.notion.com/v1/pages', {
                method: 'POST',
                headers,
                body:   JSON.stringify({ parent: { database_id: dbId }, properties }),
            });
            action = 'created';
        }

        const body = await notionRes.json();

        if (!notionRes.ok) {
            console.error('Notion write failed — status:', notionRes.status, 'code:', body?.code);
            return res.status(502).json({ error: notionErrorMessage(notionRes.status, body) });
        }

        return res.json({ ok: true, action, pageId: body.id });

    } catch (err) {
        console.error('Sync error:', err.message);
        return res.status(502).json({ error: 'Could not reach Notion — check your connection' });
    }
});

// ── Helpers ───────────────────────────────────────────────

/**
 * Query the database for a page whose Date property equals `date`.
 * Returns the page ID if found, null otherwise.
 * Query failures are swallowed so the write attempt can surface the real error.
 */
async function findExistingPage(token, dbId, date, headers) {
    try {
        const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
            method: 'POST',
            headers,
            body:   JSON.stringify({
                filter:    { property: 'Date', date: { equals: date } },
                page_size: 1,
            }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.results?.[0]?.id || null;
    } catch {
        return null;
    }
}

function notionErrorMessage(status, body) {
    if (status === 401) return 'Notion token expired — please disconnect and reconnect';
    if (status === 404) return 'Database not found — it may have been deleted or access was revoked. Choose a different database.';
    if (status === 429) return 'Notion rate limit reached — please try again in a moment';
    if (status === 400) {
        const msg = (body?.message || '').toLowerCase();
        if (msg.includes('property') || body?.code === 'validation_error') {
            return 'Property mismatch — make sure your database has columns: Date (date), Minutes (number), Goal (number), Met (checkbox)';
        }
        return `Notion rejected the request: ${body?.message || 'bad request'}`;
    }
    return `Notion error (HTTP ${status})`;
}

module.exports = router;
