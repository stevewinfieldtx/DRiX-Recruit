// auth.js — DRiX Recruit authentication + metering (central DRiX Auth client).
// ─────────────────────────────────────────────────────────────────────────────
// Same model as DRiX Ready Leads: identity + billing live in the central auth
// service (WinTech-Pay), reached via the drix-auth client. This file holds ONLY
// per-app metering (runs) + a little profile, keyed by email. It installs:
//   1. AUTH WALL  — every /api/* route (except /api/auth/*) requires a logged-in
//      BUSINESS-email user. Session = the central service's httpOnly cookie.
//   2. METERING   — the expensive Recruit endpoints consume 1 run each. Every
//      user gets FREE_RUNS trial runs; paid/entitled + internal domain = unlimited.
//   3. DEV OPEN   — set RECRUIT_DEV_OPEN=true to run locally without the central
//      service issuing a cookie (treats every request as a fixed dev user). OFF
//      by default — never enable in production.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const drixAuth = require('./drix-auth'); // shared DRiX identity + SSO session

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const FREE_RUNS        = parseInt(process.env.FREE_RUNS || '3', 10);
const RUNS_PER_PURCHASE = 10;
const MIN_PASSWORD_LEN  = 8;
const DRIX_PRICE_ID     = process.env.DRIX_PRICE_ID || ''; // checkout runs through the central auth service

const RESEND_API_KEY    = process.env.RESEND_API_KEY || '';
const REPORT_FROM_EMAIL = process.env.REPORT_FROM_EMAIL || 'steve.winfield@wintechpartners.com';

// Cross-site login (auth can live on the DRiX marketing site).
const COOKIE_DOMAIN = (process.env.COOKIE_DOMAIN || '').trim();
const LOGIN_URL     = (process.env.LOGIN_URL || '').replace(/\/+$/, '');
const AUTH_ALLOWED_ORIGINS = new Set(
  (process.env.AUTH_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
);
const ALLOWLIST_EMAILS = new Set(
  (process.env.ALLOWLIST_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

// Internal/partner accounts get unlimited runs.
const UNLIMITED_DOMAIN = (process.env.UNLIMITED_DOMAIN || 'wintechpartners.com').toLowerCase();
function isUnlimited(email) { return !!email && String(email).toLowerCase().trim().endsWith('@' + UNLIMITED_DOMAIN); }

// ── DEV OPEN ─────────────────────────────────────────────────────────────────
// Local testing without the central auth service. Treats every request as this
// fixed, entitled dev user so the gate + metering never block. OFF in prod.
const DEV_OPEN  = String(process.env.RECRUIT_DEV_OPEN || '').toLowerCase() === 'true';
const DEV_EMAIL = (process.env.RECRUIT_DEV_EMAIL || 'dev@wintechpartners.com').toLowerCase();
function devUser() { return { id: 'dev', email: DEV_EMAIL, token: 'dev', paid: true, entitlements: {} }; }

// Free / consumer email providers are NOT business emails — block them.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com','googlemail.com','yahoo.com','ymail.com','rocketmail.com','hotmail.com',
  'hotmail.co.uk','outlook.com','live.com','msn.com','aol.com','icloud.com','me.com',
  'mac.com','protonmail.com','proton.me','pm.me','gmx.com','gmx.net','mail.com',
  'zoho.com','yandex.com','yandex.ru','tutanota.com','hey.com','fastmail.com',
  'qq.com','163.com','126.com','foxmail.com','hotmail.fr','yahoo.co.uk','yahoo.fr',
  'web.de','t-online.de','comcast.net','verizon.net','att.net','sbcglobal.net',
  'cox.net','bellsouth.net','duck.com','duckduckgo.com','inbox.com','mailinator.com',
]);

// Routes that consume a run (the ones that actually cost money in upstream APIs).
const METERED_ROUTES = new Set([
  'POST /api/recruit-flow',
  'POST /api/recruit-outreach',
  'POST /api/recruit-chat',
  'POST /api/recruit-voice/provision',
  'POST /api/upload-doc',
]);

// ─── STORE (Postgres, with in-memory fallback) ───────────────────────────────
let _db = null;
const memUsers = new Map(); // email -> { runs_used, runs_granted, redeemed:Set }
function pool() { try { return _db && _db.getPool && _db.getPool(); } catch { return null; } }

async function initSchema() {
  const p = pool();
  if (!p) { console.warn('[auth] No DATABASE_URL — using in-memory user store (resets on deploy).'); return; }
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        email         TEXT PRIMARY KEY,
        runs_used     INTEGER NOT NULL DEFAULT 0,
        runs_granted  INTEGER NOT NULL DEFAULT 0,
        redeemed      JSONB   NOT NULL DEFAULT '[]'::jsonb,
        cpp_status    TEXT,
        cpp_voice     TEXT,
        cpp_checked_at TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        last_seen     TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('[auth] Schema ready (app_users)');
  } catch (e) { console.error('[auth] initSchema failed:', e.message); }
}

async function ensureUser(email) {
  const p = pool();
  if (!p) { if (!memUsers.has(email)) memUsers.set(email, { runs_used: 0, runs_granted: 0, redeemed: new Set() }); return; }
  await p.query(
    `INSERT INTO app_users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET last_seen = NOW()`,
    [email]
  );
}

async function getUser(email) {
  const p = pool();
  if (!p) {
    const u = memUsers.get(email) || { runs_used: 0, runs_granted: 0, redeemed: new Set() };
    return { email, runs_used: u.runs_used, runs_granted: u.runs_granted, redeemed: [...u.redeemed] };
  }
  const r = await p.query(`SELECT email, runs_used, runs_granted, redeemed FROM app_users WHERE email = $1`, [email]);
  if (!r.rows.length) return { email, runs_used: 0, runs_granted: 0, redeemed: [] };
  const row = r.rows[0];
  return { email, runs_used: row.runs_used, runs_granted: row.runs_granted, redeemed: row.redeemed || [] };
}

async function getProfile(email) {
  const p = pool();
  if (!p) { const u = memUsers.get(email) || {}; return { cpp_status: u.cpp_status || null, cpp_voice: u.cpp_voice || null }; }
  const r = await p.query(`SELECT cpp_status, cpp_voice FROM app_users WHERE email = $1`, [email]);
  if (!r.rows.length) return { cpp_status: null, cpp_voice: null };
  return r.rows[0];
}

async function setCpp(email, { status, voice }) {
  const p = pool();
  if (!p) { const u = memUsers.get(email) || { runs_used: 0, runs_granted: 0, redeemed: new Set() }; u.cpp_status = status; u.cpp_voice = voice ?? null; memUsers.set(email, u); return; }
  await p.query(`UPDATE app_users SET cpp_status = $2, cpp_voice = $3, cpp_checked_at = NOW() WHERE email = $1`, [email, status, voice ?? null]);
}

// Atomically consume 1 run if allowance remains. Returns the updated user, or null if exhausted.
async function consumeRun(email, entitled) {
  if (entitled || isUnlimited(email)) return { unlimited: true };
  const p = pool();
  if (!p) {
    const u = memUsers.get(email) || { runs_used: 0, runs_granted: 0, redeemed: new Set() };
    if (u.runs_used >= FREE_RUNS + u.runs_granted) return null;
    u.runs_used += 1; memUsers.set(email, u);
    return { runs_used: u.runs_used, runs_granted: u.runs_granted };
  }
  const r = await p.query(
    `UPDATE app_users SET runs_used = runs_used + 1, last_seen = NOW()
     WHERE email = $1 AND runs_used < $2 + runs_granted
     RETURNING runs_used, runs_granted`,
    [email, FREE_RUNS]
  );
  return r.rows.length ? r.rows[0] : null;
}

async function grantRuns(email, n) {
  const p = pool();
  if (!p) { const u = memUsers.get(email) || { runs_used: 0, runs_granted: 0, redeemed: new Set() }; u.runs_granted += n; memUsers.set(email, u); return; }
  await p.query(`UPDATE app_users SET runs_granted = runs_granted + $2 WHERE email = $1`, [email, n]);
}

// Brute-force guard for password login: lock 15 min after 5 misses per email.
const loginFails = new Map();
function loginLocked(email) { const f = loginFails.get(email); return !!(f && f.until > Date.now()); }
function recordLoginFail(email) {
  const f = loginFails.get(email) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  loginFails.set(email, f);
}
function clearLoginFails(email) { loginFails.delete(email); }

// ─── SESSION (delegated to the central service via drix-auth) ────────────────
function setSessionCookie(res, token) { return drixAuth.setSessionCookie(res, token); }
function clearSessionCookie(res) { return drixAuth.clearSessionCookie(res); }

async function resolveUser(req) {
  const token = drixAuth.readToken(req);
  if (!token) return null;
  const m = await drixAuth.me(token);
  if (!m || !m.user) return null;
  return { id: m.user.id, email: String(m.user.email || '').toLowerCase(), token, paid: m.paid, entitlements: m.entitlements };
}
function sessionUser(req) { return req._drix || null; }
function sessionEmail(req) { return req._drix ? req._drix.email : null; }
function sessionEntitled(req) {
  if (DEV_OPEN) return true;
  return !!(req._drix && drixAuth.isEntitled({ paid: req._drix.paid, entitlements: req._drix.entitlements }));
}

// ─── EMAIL VALIDATION ────────────────────────────────────────────────────────
function validateBusinessEmail(emailRaw) {
  const email = String(emailRaw || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  if (ADMIN_EMAIL && email === ADMIN_EMAIL) return { ok: true, email };
  if (ALLOWLIST_EMAILS.has(email)) return { ok: true, email };
  const domain = email.split('@')[1];
  if (FREE_EMAIL_DOMAINS.has(domain)) {
    return { ok: false, error: 'Please use your business email address (personal Gmail/Yahoo/Outlook etc. are not accepted).' };
  }
  return { ok: true, email };
}

// ─── INSTALL ─────────────────────────────────────────────────────────────────
function install(app, deps = {}) {
  _db = deps.db || null;
  try { app.set('trust proxy', true); } catch (_) {}
  initSchema().catch(() => {});

  // Resolve the central-service session ONCE per request and stash it on req._drix.
  app.use(async (req, _res, next) => {
    try { req._drix = await resolveUser(req); } catch (_) { req._drix = null; }
    if (!req._drix && DEV_OPEN) req._drix = devUser();
    next();
  });

  // CORS for the auth API (lets the marketing site call /api/auth/* with the cookie).
  app.use('/api/auth', (req, res, next) => {
    const origin = (req.headers.origin || '').replace(/\/+$/, '');
    if (origin && AUTH_ALLOWED_ORIGINS.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.append('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ── Auth API (email + password — instant access, no email round-trip) ──
  app.post('/api/auth/signup', async (req, res) => {
    const v = validateBusinessEmail(req.body?.email);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const password = String(req.body?.password || '');
    if (password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
    }
    try {
      const r = await drixAuth.signup(v.email, password);
      if (!r.ok) {
        if (r.status === 409) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.', code: 'ACCOUNT_EXISTS' });
        return res.status(r.status || 400).json({ error: (r.data && r.data.error) || 'Could not create your account. Try again.' });
      }
      setSessionCookie(res, r.data.session_token);
      await ensureUser(v.email);
      const u = await getUser(v.email);
      console.log(`[auth] Signup: ${v.email}`);
      res.json({ ok: true, email: v.email, remaining: Math.max(0, FREE_RUNS + u.runs_granted - u.runs_used) });
    } catch (e) { console.error('[auth] signup error:', e.message); res.status(500).json({ error: 'Could not create your account. Try again.' }); }
  });

  app.post('/api/auth/login', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });
    if (loginLocked(email)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    try {
      const r = await drixAuth.login(email, password);
      if (!r.ok) { recordLoginFail(email); return res.status(400).json({ error: 'Incorrect email or password.' }); }
      clearLoginFails(email);
      setSessionCookie(res, r.data.session_token);
      await ensureUser(email);
      const u = await getUser(email);
      res.json({ ok: true, email, remaining: Math.max(0, FREE_RUNS + u.runs_granted - u.runs_used) });
    } catch (e) { console.error('[auth] login error:', e.message); res.status(500).json({ error: 'Sign-in failed. Try again.' }); }
  });

  app.post('/api/auth/forgot-password', async (_req, res) => {
    res.json({ ok: true, notice: 'Password reset is coming soon. If you are locked out, contact support.' });
  });

  app.post('/api/auth/logout', async (req, res) => {
    try { await drixAuth.logout(drixAuth.readToken(req)); } catch (_) {}
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', async (req, res) => {
    const email = sessionEmail(req);
    if (!email) return res.status(401).json({ error: 'Not signed in' });
    await ensureUser(email);
    const u = await getUser(email);
    const entitled = sessionEntitled(req);
    const paymentsEnabled = !!DRIX_PRICE_ID && !!process.env.WINTECH_PAY_APP_KEY;
    res.json({
      email, free: FREE_RUNS, runs_used: u.runs_used, runs_granted: u.runs_granted,
      remaining: entitled ? null : Math.max(0, FREE_RUNS + u.runs_granted - u.runs_used),
      unlimited: entitled, paid: entitled,
      stripe_enabled: paymentsEnabled,
      runs_per_purchase: RUNS_PER_PURCHASE,
      is_admin: !!ADMIN_EMAIL && email === ADMIN_EMAIL,
      dev_open: DEV_OPEN,
    });
  });

  app.post('/api/auth/checkout', async (req, res) => {
    const cu = sessionUser(req);
    if (!cu) return res.status(401).json({ error: 'Not signed in' });
    if (!DRIX_PRICE_ID || !process.env.WINTECH_PAY_APP_KEY) {
      return res.status(503).json({ error: 'Payments are not configured yet. Set DRIX_PRICE_ID and WINTECH_PAY_APP_KEY.' });
    }
    const base = `${req.protocol}://${req.get('host')}`;
    const r = await drixAuth.checkout({
      priceId: DRIX_PRICE_ID,
      userToken: cu.token,
      successUrl: `${base}/?paid=1`,
      cancelUrl: `${base}/?canceled=1`,
      metadata: { app: 'drix-recruit', email: cu.email },
    });
    if (!r.ok) return res.status(502).json({ error: r.error || 'Could not start checkout.' });
    res.json({ ok: true, url: r.url });
  });

  // ── THE GATE ──
  app.use((req, res, next) => {
    const p = req.path;
    // Always-open paths (auth API + health + the ElevenLabs post-call webhook,
    // which is called by ElevenLabs, not a logged-in browser).
    if (p.startsWith('/api/auth/') || p === '/healthz' || p === '/api/recruit-voice/webhook') return next();

    const email = sessionEmail(req);

    if (p.startsWith('/api/')) {
      if (!email) return res.status(401).json({ error: 'Sign in required.', code: 'AUTH_REQUIRED' });
      req.userEmail = email;
      const key = `${req.method} ${p}`;
      if (METERED_ROUTES.has(key)) {
        const entitled = sessionEntitled(req);
        return consumeRun(email, entitled).then((u) => {
          if (!u) return res.status(402).json({ error: 'You are out of runs. Buy more to continue.', code: 'PAYMENT_REQUIRED' });
          res.set('X-Runs-Remaining', u.unlimited ? 'unlimited' : String(Math.max(0, FREE_RUNS + u.runs_granted - u.runs_used)));
          next();
        }).catch((e) => { console.error('[auth] consumeRun error:', e.message); res.status(500).json({ error: 'Metering error' }); });
      }
      return next();
    }

    // Non-API navigation: signed-in users get the app; everyone else the login wall.
    if (email) return next();
    const accept = req.headers.accept || '';
    if (req.method === 'GET' && accept.includes('text/html')) {
      if (LOGIN_URL) {
        const dest = encodeURIComponent(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
        return res.redirect(302, `${LOGIN_URL}/?signin=1&next=${dest}`);
      }
      return res.status(200).sendFile(require('path').join(__dirname, 'public', 'login.html'));
    }
    return next();
  });
}

module.exports = { install, getProfile, setCpp, grantRuns };
// end of auth.js
