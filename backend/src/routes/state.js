'use strict';
/**
 * Timer/history state sync routes
 *
 *   GET  /api/state  — fetch canonical state for the identified user
 *   POST /api/state  — save canonical state for the identified user
 *
 * Identity is resolved by the identifyUser middleware (Bearer token, session
 * cookie, or X-Guest-ID header).  Guest users get the same persistent storage
 * as Notion-connected users — no Notion auth is required.
 *
 * Only durable fields are persisted:
 *   { goalMins, history, bestStreak }
 * Ephemeral fields (active session timestamps) stay local to the browser.
 */

const router       = require('express').Router();
const identifyUser = require('../middleware/identify');
const { saveUserState, getUserState } = require('../db');

// ── GET /api/state ────────────────────────────────────────
router.get('/', identifyUser, (req, res) => {
    const row = getUserState(req.ownerId);
    if (!row) return res.json({ state: null });

    try {
        res.json({ state: JSON.parse(row.state_json), updatedAt: row.updated_at });
    } catch {
        res.json({ state: null });
    }
});

// ── POST /api/state ───────────────────────────────────────
router.post('/', identifyUser, (req, res) => {
    const { state } = req.body || {};
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return res.status(400).json({ error: 'body.state must be a plain object' });
    }

    // Sanitise: only persist known durable fields.
    const toSave = {
        goalMins:   typeof state.goalMins   === 'number'  && state.goalMins >= 1 ? state.goalMins   : 120,
        history:    typeof state.history    === 'object'  && !Array.isArray(state.history) && state.history ? state.history : {},
        bestStreak: typeof state.bestStreak === 'number'                          ? state.bestStreak : 0,
    };

    try {
        saveUserState(req.ownerId, req.ownerType, JSON.stringify(toSave));
        res.json({ ok: true, ownerType: req.ownerType });
    } catch (err) {
        console.error('Failed to save user state:', err.message);
        res.status(500).json({ error: 'Could not save state' });
    }
});

module.exports = router;
