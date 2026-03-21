'use strict';
/**
 * Notion OAuth routes
 *
 *   GET  /api/auth/notion            — redirect user to Notion's consent screen
 *   GET  /api/auth/notion/callback   — exchange code → access token, persist in DB
 *   GET  /api/auth/status            — is this session connected?
 *   POST /api/auth/logout            — disconnect (delete token, destroy session)
 *
 * References:
 *   https://developers.notion.com/docs/authorization
 */

const { randomBytes } = require('crypto');
const router = require('express').Router();
const { saveToken, getToken, deleteToken } = require('../db');

const NOTION_OAUTH_BASE = 'https://api.notion.com/v1/oauth/authorize';
const NOTION_TOKEN_URL  = 'https://api.notion.com/v1/oauth/token';

// The primary frontend URL — used as the redirect target after OAuth.
// Strips trailing slash so we can consistently append /?param=value.
const frontendBase = () => {
    const url = process.env.FRONTEND_URL.split(',')[0].trim();
    return url.endsWith('/') ? url.slice(0, -1) : url;
};

// ── 1. Initiate OAuth ─────────────────────────────────────
router.get('/notion', (req, res) => {
    const state = randomBytes(16).toString('hex');
    req.session.oauthState = state;

    // saveUninitialized is false, so we must save explicitly here to ensure
    // the cookie is set before the browser follows the redirect.
    req.session.save(err => {
        if (err) {
            console.error('Session save error before OAuth redirect:', err);
            return res.status(500).json({ error: 'Could not initiate OAuth — session error' });
        }

        const params = new URLSearchParams({
            client_id:     process.env.NOTION_CLIENT_ID,
            redirect_uri:  process.env.NOTION_REDIRECT_URI,
            response_type: 'code',
            owner:         'user',
            state,
        });

        res.redirect(`${NOTION_OAUTH_BASE}?${params}`);
    });
});

// ── 2. OAuth callback ─────────────────────────────────────
router.get('/notion/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const base = frontendBase();

    // Notion returned an error (e.g. user clicked "Cancel").
    if (error) {
        console.warn('Notion OAuth denied by user:', error);
        return res.redirect(`${base}/?notion_error=${encodeURIComponent(error)}`);
    }

    if (!code) {
        return res.redirect(`${base}/?notion_error=missing_code`);
    }

    // CSRF check: state in query must match what we stored in the session.
    // On mismatch, redirect to the frontend rather than returning raw JSON —
    // this is a browser flow so the user should see a proper page.
    if (!req.session.oauthState || req.session.oauthState !== state) {
        console.warn('OAuth state mismatch — possible CSRF or expired session');
        return res.redirect(`${base}/?notion_error=state_mismatch`);
    }
    delete req.session.oauthState;

    // Exchange the authorisation code for an access token.
    let tokenData;
    try {
        const credentials = Buffer
            .from(`${process.env.NOTION_CLIENT_ID}:${process.env.NOTION_CLIENT_SECRET}`)
            .toString('base64');

        const tokenRes = await fetch(NOTION_TOKEN_URL, {
            method:  'POST',
            headers: {
                'Authorization':  `Basic ${credentials}`,
                'Content-Type':   'application/json',
                'Notion-Version': '2022-06-28',
            },
            body: JSON.stringify({
                grant_type:   'authorization_code',
                code,
                redirect_uri: process.env.NOTION_REDIRECT_URI,
            }),
        });

        tokenData = await tokenRes.json();

        if (!tokenRes.ok) {
            // Log only the error code/message, not the full body which may contain tokens.
            console.error('Notion token exchange failed — status:', tokenRes.status, 'code:', tokenData?.code);
            const notionCode = tokenData?.code || 'token_exchange_failed';
            return res.redirect(`${base}/?notion_error=${encodeURIComponent(notionCode)}`);
        }
    } catch (err) {
        console.error('Token exchange network error:', err.message);
        return res.redirect(`${base}/?notion_error=network_error`);
    }

    // Persist token in SQLite, keyed by express-session ID.
    // The browser only ever holds a session cookie — the token stays server-side.
    try {
        saveToken(req.session.id, tokenData);
    } catch (err) {
        console.error('Failed to persist token:', err.message);
        return res.redirect(`${base}/?notion_error=storage_error`);
    }

    // Mark session as connected (cheap flag — avoids a DB lookup on /status).
    req.session.connected = true;
    req.session.save(err => {
        if (err) console.error('Session save error after token exchange:', err.message);
        res.redirect(`${base}/?notion_connected=true`);
    });
});

// ── 3. Auth status ────────────────────────────────────────
router.get('/status', (req, res) => {
    if (!req.session?.connected) {
        return res.json({ connected: false });
    }

    const row = getToken(req.session.id);
    if (!row) {
        req.session.connected = false;
        return res.json({ connected: false });
    }

    res.json({
        connected:        true,
        workspace_name:   row.workspace_name   || null,
        workspace_icon:   row.workspace_icon   || null,
        selected_db_id:   row.selected_db_id   || null,
        selected_db_name: row.selected_db_name || null,
    });
});

// ── 4. Disconnect ─────────────────────────────────────────
router.post('/logout', (req, res) => {
    if (req.session?.id) deleteToken(req.session.id);
    // Respond before destroying so the client gets the 200.
    res.json({ ok: true });
    req.session?.destroy(err => {
        if (err) console.error('Session destroy error on logout:', err.message);
    });
});

module.exports = router;
