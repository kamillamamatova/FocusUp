'use strict';
/**
 * Notion OAuth routes
 *
 * Flow (to be completed in the next pass):
 *   1. GET  /api/auth/notion            — redirect user to Notion's consent screen
 *   2. GET  /api/auth/notion/callback   — exchange code → access token, store in session
 *   3. GET  /api/auth/status            — returns whether the session has a valid token
 *   4. POST /api/auth/logout            — clears the session token
 *
 * References:
 *   https://developers.notion.com/docs/authorization
 */

const router = require('express').Router();

const NOTION_OAUTH_BASE = 'https://api.notion.com/v1/oauth/authorize';

// ── 1. Initiate OAuth ─────────────────────────────────────
// Redirect the user to Notion's consent screen.
// A random `state` value is stored in the session to prevent CSRF.
router.get('/notion', (req, res) => {
    const state = require('crypto').randomBytes(16).toString('hex');
    req.session.oauthState = state;

    const params = new URLSearchParams({
        client_id:     process.env.NOTION_CLIENT_ID,
        redirect_uri:  process.env.NOTION_REDIRECT_URI,
        response_type: 'code',
        owner:         'user',
        state,
    });

    res.redirect(`${NOTION_OAUTH_BASE}?${params}`);
});

// ── 2. OAuth callback ─────────────────────────────────────
// Notion redirects here after the user authorises (or denies).
// TODO (next pass): exchange `code` for an access token via POST /v1/oauth/token
router.get('/notion/callback', (req, res) => {
    const { code, state, error } = req.query;

    // Deny or missing code
    if (error || !code) {
        return res.redirect(
            `${process.env.FRONTEND_URL || '/'}?notion_error=${encodeURIComponent(error || 'access_denied')}`
        );
    }

    // CSRF check
    if (!req.session.oauthState || req.session.oauthState !== state) {
        return res.status(400).json({ error: 'Invalid OAuth state — possible CSRF' });
    }
    delete req.session.oauthState;

    // TODO (next pass): exchange `code` for access token
    // const token = await exchangeCodeForToken(code);
    // req.session.notionToken = token;

    // Placeholder redirect — will carry a success flag once exchange is wired
    res.redirect(`${process.env.FRONTEND_URL || '/'}?notion_connected=pending&code=${code}`);
});

// ── 3. Auth status ────────────────────────────────────────
// Frontend polls this to know whether the user is connected.
router.get('/status', (req, res) => {
    const connected = !!(req.session && req.session.notionToken);
    res.json({ connected });
});

// ── 4. Logout / disconnect ────────────────────────────────
router.post('/logout', (req, res) => {
    if (req.session) {
        delete req.session.notionToken;
    }
    res.json({ ok: true });
});

module.exports = router;
