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
const { saveToken, getToken, deleteToken, saveClientToken, getTokenByClientToken, savePendingAuth, consumePendingAuth } = require('../db');

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
    // Remember whether this was initiated from a popup (Notion embed context).
    if (req.query.popup === '1') req.session.oauthPopup = true;
    // Store the embed's polling key so we can relay the token after OAuth.
    if (req.query.embed_key) req.session.embedKey = req.query.embed_key.slice(0, 64);

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
        console.log('Token saved for workspace:', tokenData.workspace_name || tokenData.workspace_id || 'unknown');
    } catch (err) {
        console.error('Failed to persist token:', err.message);
        return res.redirect(`${base}/?notion_error=storage_error`);
    }

    // Generate a client token for localStorage-based auth (works in Notion iframes
    // where session cookies are blocked by third-party cookie restrictions).
    const clientToken = randomBytes(32).toString('hex');
    try {
        saveClientToken(req.session.id, clientToken);
    } catch (err) {
        console.error('Failed to save client token:', err.message);
        // Non-fatal — session cookie auth still works in direct tabs.
    }

    // If this OAuth was started from an embed popup, save a relay record so
    // the embed can poll for the token even if window.opener/postMessage fails.
    if (req.session.embedKey) {
        try { savePendingAuth(req.session.embedKey, req.session.id); } catch (err) {
            console.error('Failed to save pending auth:', err.message);
        }
    }

    // Mark session as connected (cheap flag — avoids a DB lookup on /status).
    req.session.connected = true;
    const isPopup = !!req.session.oauthPopup;
    const embedKey = req.session.embedKey || null;
    req.session.save(err => {
        if (err) console.error('Session save error after token exchange:', err.message);
        else console.log('Session saved, sid:', req.session.id);
        const params = new URLSearchParams({ notion_connected: 'true', ct: clientToken });
        if (isPopup) params.set('popup', '1');
        if (embedKey) params.set('embed_key', embedKey);
        res.redirect(`${base}/?${params}`);
    });
});

// ── 3. Auth status ────────────────────────────────────────
router.get('/status', (req, res) => {
    // Try Bearer token first (works in Notion iframes).
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
        const clientToken = authHeader.slice(7).trim();
        if (clientToken) {
            const row = getTokenByClientToken(clientToken);
            if (row) {
                console.log('Status check via Bearer token — workspace:', row.workspace_name);
                return res.json({
                    connected:        true,
                    workspace_name:   row.workspace_name   || null,
                    workspace_icon:   row.workspace_icon   || null,
                    selected_db_id:   row.selected_db_id   || null,
                    selected_db_name: row.selected_db_name || null,
                });
            }
        }
        return res.json({ connected: false });
    }

    // Fall back to session cookie.
    console.log('Status check via session — sid:', req.session?.id, '| connected flag:', req.session?.connected);
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
    // Delete by Bearer token if present.
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
        const clientToken = authHeader.slice(7).trim();
        if (clientToken) {
            const row = getTokenByClientToken(clientToken);
            if (row) deleteToken(row.session_id);
        }
    }
    // Also clear session-based token if present.
    if (req.session?.id) deleteToken(req.session.id);
    res.json({ ok: true });
    req.session?.destroy(err => {
        if (err) console.error('Session destroy error on logout:', err.message);
    });
});

// ── 5. Embed polling — relay token from popup to embed ─────
// The embed calls this every 2s after opening the OAuth popup.
// Returns {ready:true, clientToken} once OAuth has completed, then clears the record.
router.get('/poll', (req, res) => {
    const key = (req.query.key || '').trim();
    if (!key || key.length > 64) return res.json({ ready: false });

    const tokenRow = consumePendingAuth(key);
    if (!tokenRow || !tokenRow.client_token) return res.json({ ready: false });

    res.json({ ready: true, clientToken: tokenRow.client_token });
});

module.exports = router;
