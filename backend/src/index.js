'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');
const cors    = require('cors');

// Initialise DB before importing routes (creates schema on first run).
const { close: closeDb } = require('./db');

const authRouter = require('./routes/auth');
const syncRouter = require('./routes/sync');

// ── Validate required env vars at startup ─────────────────
const REQUIRED = ['SESSION_SECRET', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET', 'NOTION_REDIRECT_URI', 'FRONTEND_URL'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
    console.error('Missing required env vars:', missing.join(', '));
    console.error('Copy backend/.env.example to backend/.env and fill in the values.');
    process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──────────────────────────────────────────────────
const allowedOrigins = process.env.FRONTEND_URL
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        // Allow no-origin requests (curl, same-origin) in dev.
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(Object.assign(new Error(`CORS: origin not allowed: ${origin}`), { status: 403 }));
    },
    credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────
app.use(express.json());

// ── Sessions ──────────────────────────────────────────────
// PRODUCTION NOTES:
//   1. Replace MemoryStore with connect-redis (or similar) so sessions
//      survive restarts and work across multiple server instances.
//   2. Ensure NODE_ENV=production is set so secure:true activates
//      (requires HTTPS — use a reverse proxy like nginx or a PaaS that
//      terminates TLS and sets the X-Forwarded-Proto header, then also
//      set `app.set('trust proxy', 1)` here).
app.use(session({
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge:   7 * 24 * 60 * 60 * 1000, // 1 week
    },
}));

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/sync', syncRouter);

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
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────
const server = app.listen(PORT, () => {
    console.log(`FocusUp backend listening on http://localhost:${PORT}`);
    console.log(`  Health:     GET  /api/health`);
    console.log(`  OAuth:      GET  /api/auth/notion`);
    console.log(`  Callback:   GET  /api/auth/notion/callback`);
    console.log(`  Auth check: GET  /api/auth/status`);
    console.log(`  Sync:       POST /api/sync`);
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
