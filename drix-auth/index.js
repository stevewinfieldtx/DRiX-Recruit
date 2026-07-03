// drix-auth — DRiX identity client for the central auth + billing service.
// ─────────────────────────────────────────────────────────────────────────────
// The central service (WinTech-Pay, fronted by a getthedrix.com domain) owns ALL
// identity and Stripe billing for every DRiX app. This module is the thin client
// each app uses to talk to it. It holds NO database and NO Stripe — those live in
// the central service. An app's own data (runs, metering) stays in the app's DB,
// keyed by the user id that /v1/me returns.
//
// Session model: the central service issues an opaque `wts_` session token. The
// app stores it in an httpOnly cookie and validates it with a (briefly cached)
// /v1/me call. No local signing secret needed — the token is validated remotely.
//
// Env:
//   DRIX_AUTH_URL          base URL of the central service
//                          (falls back to WINTECH_PAY_URL, then the prod default)
//   COOKIE_DOMAIN          ".getthedrix.com"  (blank = host-only, dev)
//   SESSION_COOKIE_NAME    default "drix_session"
//   WINTECH_PAY_APP_KEY    wtp_… app key — only needed for checkout()
//   WINTECH_PAY_APP_ID     this app's id in the central service — the entitlement key
// ─────────────────────────────────────────────────────────────────────────────

const AUTH_BASE = (process.env.DRIX_AUTH_URL
  || process.env.WINTECH_PAY_URL
  || 'https://wintech-pay-production.up.railway.app').replace(/\/+$/, '');

const COOKIE_NAME    = process.env.SESSION_COOKIE_NAME || 'drix_session';
const COOKIE_DOMAIN  = (process.env.COOKIE_DOMAIN || '').trim();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // matches the service's 30-day session
const ME_CACHE_MS    = 60 * 1000;                 // cache /v1/me per token to avoid a hop per request

const APP_KEY = process.env.WINTECH_PAY_APP_KEY || '';
const APP_ID  = process.env.WINTECH_PAY_APP_ID  || '';

// ─── low-level HTTP ──────────────────────────────────────────────────────────
async function api(path, { method = 'GET', token, appKey, body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (appKey) headers['Authorization'] = `Bearer ${appKey}`;
  else if (token) headers['Authorization'] = `Bearer ${token}`;
  let res, data;
  try {
    res = await fetch(`${AUTH_BASE}${path}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'auth service unreachable' }, networkError: e.message };
  }
  try { data = await res.json(); } catch { data = {}; }
  return { ok: res.ok, status: res.status, data };
}

// ─── auth (public endpoints) ─────────────────────────────────────────────────
// Each returns { ok, status, data }. On success, data has { user:{id,email}, session_token }.
function signup(email, password) { return api('/v1/auth/signup', { method: 'POST', body: { email, password } }); }
function login(email, password)  { return api('/v1/auth/login',  { method: 'POST', body: { email, password } }); }
async function logout(token)     { if (token) { invalidate(token); await api('/v1/auth/logout', { method: 'POST', token }).catch(() => {}); } }

// ─── /v1/me with a short per-token cache ─────────────────────────────────────
const _meCache = new Map(); // token -> { exp, data }
async function me(token, { fresh = false } = {}) {
  if (!token) return null;
  if (!fresh) { const c = _meCache.get(token); if (c && c.exp > Date.now()) return c.data; }
  const r = await api('/v1/me', { token });
  if (!r.ok) { _meCache.delete(token); return null; }
  _meCache.set(token, { exp: Date.now() + ME_CACHE_MS, data: r.data });
  return r.data; // { user:{id,email}, paid, entitlements }
}
function invalidate(token) { if (token) _meCache.delete(token); }

// Has THIS app's entitlement (paid)? Falls back to the global `paid` flag if no
// APP_ID is configured yet (e.g. before the wtp_ app key step).
function isEntitled(meData) {
  if (!meData) return false;
  if (APP_ID) return !!(meData.entitlements && meData.entitlements[APP_ID]);
  return !!meData.paid;
}

// ─── checkout (needs the wtp_ app key) ───────────────────────────────────────
async function checkout({ priceId, userToken, successUrl, cancelUrl, metadata } = {}) {
  if (!APP_KEY) return { ok: false, error: 'WINTECH_PAY_APP_KEY not set — payments not configured yet.' };
  if (!priceId) return { ok: false, error: 'No price configured (DRiX price_id missing).' };
  const r = await api('/v1/checkout', {
    method: 'POST', appKey: APP_KEY,
    body: { price_id: priceId, user_token: userToken, success_url: successUrl, cancel_url: cancelUrl, metadata },
  });
  return r.ok
    ? { ok: true, url: r.data.checkout_url, orderId: r.data.order_id }
    : { ok: false, error: r.data.error || r.data.message || 'Could not start checkout.', status: r.status };
}

// ─── cookie helpers (the app stores the wts_ token in an httpOnly cookie) ─────
function parseCookies(req) {
  const out = {};
  const raw = req.headers && req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function readToken(req) { return parseCookies(req)[COOKIE_NAME] || null; }
function setSessionCookie(res, token) {
  const attrs = [
    `${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`, 'Secure',
  ];
  if (COOKIE_DOMAIN) attrs.push(`Domain=${COOKIE_DOMAIN}`);
  res.append('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', 'Secure'];
  if (COOKIE_DOMAIN) attrs.push(`Domain=${COOKIE_DOMAIN}`);
  res.append('Set-Cookie', attrs.join('; '));
}

// ─── express middleware ──────────────────────────────────────────────────────
// Resolves the session (if any) and attaches req.drixUser; never blocks.
async function attachUser(req, _res, next) {
  try {
    const token = readToken(req);
    const m = token ? await me(token) : null;
    if (m && m.user) req.drixUser = { id: m.user.id, email: m.user.email, paid: m.paid, entitlements: m.entitlements, token };
  } catch (_) { /* fail open to unauthenticated */ }
  next();
}
// 401 unless a valid session is present.
async function requireAuth(req, res, next) {
  const token = readToken(req);
  const m = token ? await me(token) : null;
  if (!m || !m.user) return res.status(401).json({ error: 'Sign in required.', code: 'AUTH_REQUIRED' });
  req.drixUser = { id: m.user.id, email: m.user.email, paid: m.paid, entitlements: m.entitlements, token };
  next();
}

module.exports = {
  AUTH_BASE, COOKIE_NAME, APP_ID,
  signup, login, logout, me, invalidate, isEntitled, checkout,
  parseCookies, readToken, setSessionCookie, clearSessionCookie,
  attachUser, requireAuth,
};
