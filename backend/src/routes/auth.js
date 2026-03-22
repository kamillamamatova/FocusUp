'use strict';
/**
 * Auth routes
 *
 *   POST /api/auth/register          — create email/password account
 *   POST /api/auth/login             — sign in with email/password
 *   GET  /api/auth/me                — return current app-user session (if any)
 *   POST /api/auth/app-logout        — sign out of app account only
 *   GET  /api/auth/notion            — redirect user to Notion's consent screen
 *   GET  /api/auth/notion/callback   — exchange code → access token, persist in DB
 *   GET  /api/auth/status            — is this session Notion-connected?
 *   POST /api/auth/logout            — disconnect Notion (delete token, destroy session)
 *
 * References:
 *   https://developers.notion.com/docs/authorization
 */

const { randomBytes, scrypt, timingSafeEqual } = require('crypto');
const { promisify }  = require('util');
const router         = require('express').Router();
const {
    saveToken, getToken, deleteToken, saveClientToken, getTokenByClientToken,
    migrateGuestToNotion, createUser, getUserByEmail, getUserById, migrateGuestToApp,
} = require('../db');

// ── Password hashing (Node built-in crypto.scrypt, no extra deps) ─────────
const scryptAsync = promisify(scrypt);
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const buf  = await scryptAsync(password, salt, 64, SCRYPT_OPTS);
    return `scrypt:${salt}:${buf.toString('hex')}`;
}

async function verifyPassword(password, stored) {
    const [, salt, key] = stored.split(':');
    const buf = await scryptAsync(password, salt, 64, SCRYPT_OPTS);
    return timingSafeEqual(Buffer.from(key, 'hex'), buf);
}

// ── POST /api/auth/register ───────────────────────────────
router.post('/register', async (req, res) => {
    const { email, password, guestId } = req.body || {};

    if (typeof email !== 'string' || !email.includes('@') || email.length > 254) {
        return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    if (getUserByEmail(email)) {
        return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    try {
        const hash = await hashPassword(password);
        const id   = randomBytes(16).toString('hex');
        const user = createUser(id, email.toLowerCase().trim(), hash);

        // Migrate guest history into the new account.
        if (typeof guestId === 'string' && guestId) migrateGuestToApp(guestId, id);

        req.session.userId    = user.id;
        req.session.userEmail = user.email;
        req.session.save(err => {
            if (err) console.error('Session save error after register:', err.message);
        });

        res.json({ ok: true, user: { id: user.id, email: user.email } });
    } catch (err) {
        console.error('Register error:', err.message);
        res.status(500).json({ error: 'Could not create account. Please try again.' });
    }
});

// ── POST /api/auth/login ──────────────────────────────────
router.post('/login', async (req, res) => {
    const { email, password, guestId } = req.body || {};

    if (typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = getUserByEmail(email.trim());
    if (!user) {
        return res.status(401).json({ error: 'No account found with that email.' });
    }

    try {
        const ok = await verifyPassword(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'Incorrect password.' });

        // Migrate any guest history accumulated before logging in.
        if (typeof guestId === 'string' && guestId) migrateGuestToApp(guestId, user.id);

        req.session.userId    = user.id;
        req.session.userEmail = user.email;
        req.session.save(err => {
            if (err) console.error('Session save error after login:', err.message);
        });

        res.json({ ok: true, user: { id: user.id, email: user.email } });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Sign-in failed. Please try again.' });
    }
});

// ── GET /api/auth/me ──────────────────────────────────────
router.get('/me', (req, res) => {
    if (!req.session?.userId) return res.json({ user: null });
    const user = getUserById(req.session.userId);
    if (!user) {
        delete req.session.userId;
        return res.json({ user: null });
    }
    res.json({ user: { id: user.id, email: user.email } });
});

// ── POST /api/auth/app-logout ─────────────────────────────
router.post('/app-logout', (req, res) => {
    delete req.session.userId;
    delete req.session.userEmail;
    req.session.save(() => {});
    res.json({ ok: true });
});

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
    // Store the guest ID so we can migrate their data into the Notion workspace after OAuth.
    if (req.query.guest_id) req.session.guestId = req.query.guest_id.slice(0, 64);

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

    // If this session carried a guest_id, migrate the guest's timer history into
    // the Notion workspace so the user doesn't lose data collected before signing in.
    if (req.session.guestId && tokenData.workspace_id) {
        try {
            migrateGuestToNotion(req.session.guestId, tokenData.workspace_id);
        } catch (err) {
            console.error('Guest migration error (non-fatal):', err.message);
        }
        delete req.session.guestId;
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

    // Mark session as connected (cheap flag — avoids a DB lookup on /status).
    req.session.connected = true;
    req.session.save(err => {
        if (err) console.error('Session save error after token exchange:', err.message);
        else console.log('Session saved, sid:', req.session.id);
        const params = new URLSearchParams({ notion_connected: 'true', ct: clientToken });
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


module.exports = router;
