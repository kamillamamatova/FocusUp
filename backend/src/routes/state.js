'use strict';
/**
 * Timer/history state sync routes
 *
 *   GET  /api/state  — fetch durable state for the authenticated workspace
 *   POST /api/state  — save durable state for the authenticated workspace
 *
 * State is keyed by Notion workspace_id so it survives re-authentication and
 * is shared across all devices that connect to the same Notion workspace.
 *
 * Only durable fields are persisted (goalMins, history, bestStreak).
 * Ephemeral session data (active timer ticks, sessions array) stays local.
 */

const router      = require('express').Router();
const requireAuth = require('../middleware/auth');
const { saveAppState, getAppState } = require('../db');

// ── GET /api/state ────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
    const workspaceId = req.tokenRow.workspace_id;
    if (!workspaceId) return res.json({ state: null });

    const row = getAppState(workspaceId);
    if (!row) return res.json({ state: null });

    try {
        res.json({ state: JSON.parse(row.state_json), updatedAt: row.updated_at });
    } catch {
        res.json({ state: null });
    }
});

// ── POST /api/state ───────────────────────────────────────
router.post('/', requireAuth, (req, res) => {
    const workspaceId = req.tokenRow.workspace_id;
    if (!workspaceId) {
        return res.status(400).json({ error: 'workspace_id not available for this token' });
    }

    const { state } = req.body || {};
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return res.status(400).json({ error: 'body.state must be a plain object' });
    }

    // Only persist durable fields — ignore ephemeral session/tick data.
    const toSave = {
        goalMins:   typeof state.goalMins === 'number'  && state.goalMins >= 1  ? state.goalMins  : 120,
        history:    typeof state.history  === 'object'  && !Array.isArray(state.history) && state.history ? state.history : {},
        bestStreak: typeof state.bestStreak === 'number' ? state.bestStreak : 0,
    };

    try {
        saveAppState(workspaceId, JSON.stringify(toSave));
        res.json({ ok: true });
    } catch (err) {
        console.error('Failed to save app state:', err.message);
        res.status(500).json({ error: 'Could not save state' });
    }
});

module.exports = router;
