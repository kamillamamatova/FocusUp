'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');
const cors    = require('cors');

const authRouter = require('./routes/auth');
const syncRouter = require('./routes/sync');

// ── Validate required env vars at startup ─────────────────
const REQUIRED = ['SESSION_SECRET', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET', 'NOTION_REDIRECT_URI'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
    console.error('Missing required env vars:', missing.join(', '));
    console.error('Copy backend/.env.example to backend/.env and fill in the values.');
    process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──────────────────────────────────────────────────
// Allow the frontend origin (and the Notion embed iframe origin).
const allowedOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        // Allow requests with no origin (e.g. curl, server-to-server) in dev.
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────
app.use(express.json());

// ── Sessions ──────────────────────────────────────────────
// MemoryStore is fine for development.
// For production swap this for connect-redis or another persistent store:
//   const RedisStore = require('connect-redis')(session);
//   store: new RedisStore({ client: redisClient })
app.use(session({
    secret:            process.env.SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',  // HTTPS only in prod
        sameSite: 'lax',
        maxAge:   7 * 24 * 60 * 60 * 1000,               // 1 week
    },
}));

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth',  authRouter);
app.use('/api/sync',  syncRouter);

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
app.listen(PORT, () => {
    console.log(`FocusUp backend listening on http://localhost:${PORT}`);
    console.log(`  Health:  GET  /api/health`);
    console.log(`  OAuth:   GET  /api/auth/notion`);
    console.log(`  Sync:    POST /api/sync`);
});
