'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');
const cors    = require('cors');

// Initialise DB before importing routes (creates schema on first run).
const { db, close: closeDb } = require('./db');
const SQLiteStore             = require('./session-store');

const authRouter      = require('./routes/auth');
const syncRouter      = require('./routes/sync');
const databasesRouter = require('./routes/databases');
const stateRouter     = require('./routes/state');

// ── Validate required env vars at startup ─────────────────
const REQUIRED = ['SESSION_SECRET', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET', 'NOTION_REDIRECT_URI', 'FRONTEND_URL'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
    console.error('Missing required env vars:', missing.join(', '));
    console.error('Copy backend/.env.example to backend/.env and fill in the values.');
    process.exit(1);
}

const app        = express();
const PORT       = process.env.PORT || 3001;
const IS_PROD    = process.env.NODE_ENV === 'production';

// ── Trust proxy ───────────────────────────────────────────
// Required when running behind a reverse proxy (Railway, Render, Heroku, nginx).
// Without this, req.secure is always false and the session cookie's `secure`
// flag is never set, even over HTTPS.
if (IS_PROD) app.set('trust proxy', 1);

// ── CORS ──────────────────────────────────────────────────
// Extract origins from FRONTEND_URL for CORS — strips any path component so
// a full app URL like https://example.github.io/FocusUp works correctly.
const allowedOrigins = process.env.FRONTEND_URL
    .split(',')
    .map(s => { try { return new URL(s.trim()).origin; } catch { return s.trim(); } })
    .filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        // Allow requests with no Origin header (browser navigations, OAuth redirects).
        // These are not cross-origin fetch requests and cannot carry CSRF risk.
        if (!origin) return cb(null, true);
        if (origin && allowedOrigins.includes(origin)) return cb(null, true);
        cb(Object.assign(new Error(`CORS: origin not allowed: ${origin}`), { status: 403 }));
    },
    credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────
// 10 kb limit is well above any legitimate request body in this app.
app.use(express.json({ limit: '10kb' }));

// ── Sessions ──────────────────────────────────────────────
// SQLiteStore persists sessions in the same focusup.db database so they
// survive backend restarts (e.g. Render sleep/wake cycles).
app.use(session({
    store:             new SQLiteStore(db),
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure:   IS_PROD,
        // SameSite=None is required for cross-site requests (frontend on github.io,
        // backend on onrender.com). Requires Secure=true, which IS_PROD enforces.
        sameSite: IS_PROD ? 'none' : 'lax',
        maxAge:   7 * 24 * 60 * 60 * 1000, // 1 week
    },
}));

// ── Request logging ───────────────────────────────────────
app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth',      authRouter);
app.use('/api/sync',      syncRouter);
app.use('/api/databases', databasesRouter);
app.use('/api/state',     stateRouter);

app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 ───────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// ── Error handler ─────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    // Always log the full error server-side for diagnostics.
    console.error(err.stack || err);
    // Return minimal detail to the client — never expose stack traces.
    const status  = err.status || 500;
    const message = status < 500 ? (err.message || 'Bad request') : 'Internal server error';
    res.status(status).json({ error: message });
});

// ── Start ─────────────────────────────────────────────────
const server = app.listen(PORT, () => {
    console.log(`FocusUp backend listening on http://localhost:${PORT}`);
    console.log(`  Health:       GET  /api/health`);
    console.log(`  OAuth:        GET  /api/auth/notion`);
    console.log(`  Callback:     GET  /api/auth/notion/callback`);
    console.log(`  Auth check:   GET  /api/auth/status`);
    console.log(`  List DBs:     GET  /api/databases`);
    console.log(`  Select DB:    POST /api/databases/select`);
    console.log(`  Sync:         POST /api/sync`);
    console.log(`  State get:    GET  /api/state   (guest or Notion)`);
    console.log(`  State set:    POST /api/state   (guest or Notion)`);
});

// ── Graceful shutdown ─────────────────────────────────────
function shutdown(signal) {
    console.log(`\n${signal} received — shutting down`);
    server.close(() => {
        closeDb();
        process.exit(0);
    });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
