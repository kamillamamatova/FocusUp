'use strict';
/**
 * Sync routes
 *
 * POST /api/sync  — write a finished-day entry to the user's Notion database.
 *
 * TODO (next pass): implement using the access token stored in session after
 * OAuth is complete.  For now the route validates the request shape and
 * returns a 501 so the frontend can detect the backend is reachable but
 * OAuth is not yet wired.
 *
 * Expected request body:
 *   {
 *     date:    "YYYY-MM-DD",   // ISO date string
 *     minutes: number,         // total focused minutes
 *     goal:    number,         // daily goal in minutes
 *     met:     boolean         // whether goal was met
 *   }
 */

const router = require('express').Router();

// ── Auth guard middleware ──────────────────────────────────
// Rejects requests that don't have a session token.
// Will be used once OAuth is wired.
function requireAuth(req, res, next) {
    if (!req.session || !req.session.notionToken) {
        return res.status(401).json({ error: 'Not authenticated — connect Notion first' });
    }
    next();
}

// ── POST /api/sync ────────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
    const { date, minutes, goal, met } = req.body || {};

    // Validate shape
    if (
        typeof date    !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        typeof minutes !== 'number' || minutes < 0 ||
        typeof goal    !== 'number' || goal < 1 ||
        typeof met     !== 'boolean'
    ) {
        return res.status(400).json({
            error: 'Invalid request body',
            expected: { date: 'YYYY-MM-DD', minutes: 'number >= 0', goal: 'number >= 1', met: 'boolean' },
        });
    }

    // TODO (next pass): call Notion API with session token
    // const notionToken = req.session.notionToken.access_token;
    // const dbId = req.session.notionToken.duplicated_template_id ?? req.body.dbId;
    // await createNotionPage(notionToken, dbId, { date, minutes, goal, met });

    res.status(501).json({
        error: 'Sync not yet implemented — OAuth wiring is the next step',
        received: { date, minutes, goal, met },
    });
});

module.exports = router;
