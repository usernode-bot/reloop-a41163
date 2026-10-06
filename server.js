const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ── ReLoop — digital waste bank ─────────────────────────────────────────────
//
// One neighborhood waste bank. Residents deposit sorted waste; waste bank
// managers (admins) record deposits, set waste-type prices, manage rewards
// and hand out redemptions. Points are the only currency (integer points,
// weights as integer grams — never floats).
//
// The first manager promotes themselves once with a shared setup code
// (ADMIN_SETUP_CODE, configured in the app's Secrets); from then on managers
// manage each other. Guest visitors can read the catalog; every write needs
// an account, which the platform's auth middleware above already enforces.

// The shared secret the neighborhood's first manager uses once to claim the
// role. Declared in dapp.json's secrets; unset value = setup not available.
const ADMIN_SETUP_CODE = process.env.ADMIN_SETUP_CODE || '';

// An error with an HTTP status and a stable code the frontend can show a
// sentence for. Anything else is an unexpected failure and answers 500.
class ApiError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template shipped no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Schema (idempotent, applied on boot) ────────────────────────────────────
//
// Public tables: `waste_types` and `rewards` — neighborhood reference data
// (prices, catalog) a stranger could safely see.
//
// Private tables (`staging:private` — staging copies them schema-only):
// `members` (points balances are financial data, phone numbers personal),
// `deposits`/`deposit_items`, `redemptions` and `point_transactions` (the
// audit ledger). No public table carries a foreign key to a private one;
// private→public FKs (deposit_items→waste_types, redemptions→rewards) are
// fine because public tables copy WITH their rows to staging.
async function migrate() {
  await pool.query(`DROP TABLE IF EXISTS presses`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waste_types (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      points_per_kg INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rewards (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      points_cost INTEGER NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      username TEXT NOT NULL,
      display_name TEXT,
      house_no TEXT,
      phone TEXT,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      points_balance INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposits (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id),
      recorded_by INTEGER NOT NULL,
      total_points INTEGER NOT NULL DEFAULT 0,
      voided BOOLEAN NOT NULL DEFAULT FALSE,
      voided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposit_items (
      id SERIAL PRIMARY KEY,
      deposit_id INTEGER NOT NULL REFERENCES deposits(id),
      waste_type_id INTEGER NOT NULL REFERENCES waste_types(id),
      label TEXT NOT NULL,
      weight_g INTEGER NOT NULL,
      points INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS redemptions (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id),
      reward_id INTEGER NOT NULL REFERENCES rewards(id),
      points_spent INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      handled_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS point_transactions (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id),
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ref_type TEXT,
      ref_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (const t of ['members', 'deposits', 'deposit_items', 'redemptions', 'point_transactions']) {
    await pool.query(`COMMENT ON TABLE ${t} IS 'staging:private'`);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS deposits_member_created ON deposits (member_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS redemptions_member_created ON redemptions (member_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS point_tx_member ON point_transactions (member_id, created_at DESC)`);
}

// ── Staging seed data ───────────────────────────────────────────────────────
//
// Runs on every staging boot, idempotent, obviously fake ("Staging demo …"),
// fixed high ids so real rows can never collide. Never references a real
// user: the visitor's own member row is created lazily with 0 points, which
// is the honest production state. Balances below match the seeded ledger
// exactly (deposits 284 − redemptions 180 = 104 for the demo user).
async function seedStaging() {
  const wasteTypes = [
    [900001, 'Staging demo: PET plastic bottles', 15],
    [900002, 'Staging demo: Paper', 8],
    [900003, 'Staging demo: Cardboard', 10],
    [900004, 'Staging demo: Aluminium cans', 40],
    [900005, 'Staging demo: Glass bottles', 5],
    [900006, 'Staging demo: Used cooking oil', 60],
  ];
  for (const [id, name, ppk] of wasteTypes) {
    await pool.query(
      `INSERT INTO waste_types (id, name, points_per_kg) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [id, name, ppk]
    );
  }
  const rewards = [
    [900001, 'Staging demo reward: Rice 1 kg', 500, 20],
    [900002, 'Staging demo reward: Cooking oil 1 L', 300, 10],
    [900003, 'Staging demo reward: Bath soap', 120, 50],
    [900004, 'Staging demo reward: Eggs (10)', 250, 0],
    [900005, 'Staging demo reward: Reusable bag', 60, 30],
  ];
  for (const [id, name, cost, stock] of rewards) {
    await pool.query(
      `INSERT INTO rewards (id, name, points_cost, stock) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [id, name, cost, stock]
    );
  }
  // user_id equals id here on purpose: these are fake platform identities.
  const members = [
    [900001, 'staging-demo-manager', 'Staging Demo Manager', 'House 01 / RT 01', true, 0],
    [900002, 'staging-demo-user', 'Staging Demo User', 'House 12 / RT 03', false, 104],
    [900003, 'staging-demo-neighbour', 'Staging Demo Neighbour', 'House 07 / RT 02', false, 124],
  ];
  for (const [id, username, displayName, houseNo, isAdmin, balance] of members) {
    await pool.query(
      `INSERT INTO members (id, user_id, username, display_name, house_no, is_admin, points_balance)
       VALUES ($1, $1, $2, $3, $4, $5, $6) ON CONFLICT (user_id) DO NOTHING`,
      [id, username, displayName, houseNo, isAdmin, balance]
    );
  }
  // [deposit id, member id, total, days ago, [[waste_type id, weight_g, points], …]]
  const deposits = [
    [900101, 900002, 52, 21, [[900001, 1500, 22], [900003, 3000, 30]]],
    [900102, 900002, 32, 14, [[900004, 800, 32]]],
    [900103, 900002, 120, 9, [[900006, 2000, 120]]],
    [900104, 900002, 80, 4, [[900002, 10000, 80]]],
    [900105, 900003, 69, 12, [[900001, 2500, 37], [900002, 4000, 32]]],
    [900106, 900003, 55, 5, [[900003, 5500, 55]]],
  ];
  for (const [id, memberId, total, daysAgo, items] of deposits) {
    const ins = await pool.query(
      `INSERT INTO deposits (id, member_id, recorded_by, total_points, created_at)
       VALUES ($1, $2, 900001, $3, NOW() - ($4 || ' days')::interval) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, memberId, total, daysAgo]
    );
    if (!ins.rows.length) continue; // already seeded; skip items + ledger
    for (const [wtId, weightG, points] of items) {
      const label = wasteTypes.find(w => w[0] === wtId)[1];
      await pool.query(
        `INSERT INTO deposit_items (deposit_id, waste_type_id, label, weight_g, points) VALUES ($1, $2, $3, $4, $5)`,
        [id, wtId, label, weightG, points]
      );
    }
    await pool.query(
      `INSERT INTO point_transactions (member_id, delta, reason, ref_type, ref_id, created_at)
       VALUES ($1, $2, 'deposit', 'deposit', $3, NOW() - ($4 || ' days')::interval)`,
      [memberId, total, id, daysAgo]
    );
  }
  // Redemptions: one still waiting for pickup, one already handed over.
  const redemptions = [
    [900401, 900002, 900003, 120, 'pending', 2, null],
    [900402, 900002, 900005, 60, 'picked_up', 6, 5],
  ];
  for (const [id, memberId, rewardId, cost, status, daysAgo, resolvedDaysAgo] of redemptions) {
    const ins = await pool.query(
      `INSERT INTO redemptions (id, member_id, reward_id, points_spent, status, handled_by, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() - make_interval(days => $7),
               CASE WHEN $8::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $8::int) END)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, memberId, rewardId, cost, status, status === 'picked_up' ? 900001 : null, daysAgo, resolvedDaysAgo]
    );
    if (!ins.rows.length) continue;
    await pool.query(
      `INSERT INTO point_transactions (member_id, delta, reason, ref_type, ref_id, created_at)
       VALUES ($1, $2, 'redemption', 'redemption', $3, NOW() - ($4 || ' days')::interval)`,
      [memberId, -cost, id, daysAgo]
    );
  }
  // Explicit ids bypass the sequences; push each sequence past the highest
  // seeded id so real inserts can never collide with demo rows.
  for (const t of ['waste_types', 'rewards', 'members', 'deposits', 'deposit_items', 'redemptions', 'point_transactions']) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${t}), 1))`
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Run `fn(client)` inside one transaction; roll back on any throw.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

// Points for one deposit line, computed SERVER-side from the current price:
// `floor(weight_g × points_per_kg / 1000)`. The client only previews this.
function pointsFor(weightG, pointsPerKg) {
  return Math.floor((weightG * pointsPerKg) / 1000);
}

function getMemberByUser(userId) {
  return pool.query(
    `SELECT id, user_id, username, display_name, house_no, phone, is_admin, points_balance
     FROM members WHERE user_id = $1`, [userId]
  ).then(r => r.rows[0] || null);
}

// Every authenticated /api request lazily provisions the caller's member row
// (balance 0, resident). Production-shaped: nothing seeds real visitors.
app.use('/api', (req, res, next) => {
  if (!req.user) return next();
  pool.query(
    `INSERT INTO members (user_id, username) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
    [req.user.id, req.user.username]
  ).then(() => next(), next);
});

// Admin (waste bank manager) gate. Loads the caller's member row onto
// req.member for the routes that need it.
async function requireAdmin(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const member = await getMemberByUser(req.user.id);
    if (!member || !member.is_admin) return res.status(403).json({ error: 'manager_only' });
    req.member = member;
    next();
  } catch (err) { next(err); }
}

function intParam(req, name) {
  const v = parseInt(req.params[name], 10);
  if (!Number.isInteger(v) || v <= 0) throw new ApiError(400, 'invalid_id');
  return v;
}

// Strings coming from forms: trim, cap length, empty → null.
function cleanText(v, maxLen) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, maxLen) : null;
}

function cleanInt(v, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < min || i > max) return null;
  return i;
}

function memberJson(m) {
  return {
    id: m.id,
    username: m.username,
    display_name: m.display_name,
    house_no: m.house_no,
    phone: m.phone,
    is_admin: m.is_admin,
    points_balance: m.points_balance,
  };
}

// ── Me ──────────────────────────────────────────────────────────────────────

app.get('/api/me', async (req, res, next) => {
  try {
    const setupConfigured = !!ADMIN_SETUP_CODE;
    if (!req.user) return res.json({ guest: true, member: null, setup_configured: setupConfigured });
    const m = await getMemberByUser(req.user.id);
    if (!m) throw new ApiError(500, 'member_missing');
    const stats = await pool.query(`
      SELECT COALESCE(SUM(i.weight_g), 0) AS total_weight_g, COUNT(DISTINCT d.id) AS deposit_count
      FROM deposits d JOIN deposit_items i ON i.deposit_id = d.id
      WHERE d.member_id = $1 AND d.voided = FALSE
    `, [m.id]);
    res.json({
      member: memberJson(m),
      setup_configured: setupConfigured,
      stats: {
        total_weight_g: parseInt(stats.rows[0].total_weight_g, 10),
        deposit_count: parseInt(stats.rows[0].deposit_count, 10),
      },
    });
  } catch (err) { next(err); }
});

app.patch('/api/me', async (req, res, next) => {
  try {
    const m = await getMemberByUser(req.user.id);
    // Fields sent in the body are SET (an empty string clears them); fields
    // left out keep their current value.
    await pool.query(`
      UPDATE members SET
        display_name = $2, house_no = $3, phone = $4
      WHERE id = $1
    `, [m.id,
        'display_name' in req.body ? cleanText(req.body.display_name, 120) : m.display_name,
        'house_no' in req.body ? cleanText(req.body.house_no, 120) : m.house_no,
        'phone' in req.body ? cleanText(req.body.phone, 40) : m.phone]);
    res.json({ member: memberJson(await getMemberByUser(req.user.id)) });
  } catch (err) { next(err); }
});

// One-time self-promotion for the neighborhood's first waste bank manager.
app.post('/api/admin/setup', async (req, res, next) => {
  try {
    if (!ADMIN_SETUP_CODE) throw new ApiError(400, 'setup_not_configured');
    const code = typeof req.body.code === 'string' ? req.body.code : '';
    const a = Buffer.from(code);
    const b = Buffer.from(ADMIN_SETUP_CODE);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) throw new ApiError(403, 'invalid_code');
    await pool.query(`UPDATE members SET is_admin = TRUE WHERE user_id = $1`, [req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Waste types (prices) ────────────────────────────────────────────────────

app.get('/api/waste-types', async (req, res, next) => {
  try {
    const me = req.user ? await getMemberByUser(req.user.id) : null;
    const showAll = !!(me && me.is_admin) && req.query.all === '1';
    const { rows } = await pool.query(`
      SELECT id, name, points_per_kg, active FROM waste_types
      ${showAll ? '' : 'WHERE active = TRUE'}
      ORDER BY name
    `);
    res.json({ waste_types: rows });
  } catch (err) { next(err); }
});

app.post('/api/waste-types', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 120);
    const ppk = cleanInt(req.body.points_per_kg, 0, 1000000);
    if (!name) throw new ApiError(400, 'name_required');
    if (ppk === null) throw new ApiError(400, 'invalid_points_per_kg');
    const { rows } = await pool.query(
      `INSERT INTO waste_types (name, points_per_kg) VALUES ($1, $2) RETURNING id, name, points_per_kg, active`,
      [name, ppk]
    );
    res.status(201).json({ waste_type: rows[0] });
  } catch (err) { next(err); }
});

app.patch('/api/waste-types/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    const name = cleanText(req.body.name, 120);
    const ppk = 'points_per_kg' in req.body ? cleanInt(req.body.points_per_kg, 0, 1000000) : undefined;
    const active = 'active' in req.body ? !!req.body.active : undefined;
    if (req.body.name !== undefined && !name) throw new ApiError(400, 'name_required');
    if (ppk === null) throw new ApiError(400, 'invalid_points_per_kg');
    const { rows } = await pool.query(`
      UPDATE waste_types SET
        name = COALESCE($2, name),
        points_per_kg = COALESCE($3, points_per_kg),
        active = COALESCE($4, active)
      WHERE id = $1
      RETURNING id, name, points_per_kg, active
    `, [id, name, ppk === undefined ? null : ppk, active === undefined ? null : active]);
    if (!rows.length) throw new ApiError(404, 'waste_type_not_found');
    res.json({ waste_type: rows[0] });
  } catch (err) { next(err); }
});

// ── Rewards ─────────────────────────────────────────────────────────────────

app.get('/api/rewards', async (req, res, next) => {
  try {
    const me = req.user ? await getMemberByUser(req.user.id) : null;
    const showAll = !!(me && me.is_admin) && req.query.all === '1';
    const { rows } = await pool.query(`
      SELECT id, name, points_cost, stock, active FROM rewards
      ${showAll ? '' : 'WHERE active = TRUE'}
      ORDER BY points_cost, name
    `);
    res.json({ rewards: rows });
  } catch (err) { next(err); }
});

app.post('/api/rewards', requireAdmin, async (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 120);
    const cost = cleanInt(req.body.points_cost, 0, 100000000);
    const stock = cleanInt(req.body.stock, 0, 1000000);
    if (!name) throw new ApiError(400, 'name_required');
    if (cost === null || stock === null) throw new ApiError(400, 'invalid_reward');
    const { rows } = await pool.query(
      `INSERT INTO rewards (name, points_cost, stock) VALUES ($1, $2, $3)
       RETURNING id, name, points_cost, stock, active`,
      [name, cost, stock]
    );
    res.status(201).json({ reward: rows[0] });
  } catch (err) { next(err); }
});

app.patch('/api/rewards/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    const name = cleanText(req.body.name, 120);
    const cost = 'points_cost' in req.body ? cleanInt(req.body.points_cost, 0, 100000000) : undefined;
    const stock = 'stock' in req.body ? cleanInt(req.body.stock, 0, 1000000) : undefined;
    const active = 'active' in req.body ? !!req.body.active : undefined;
    if (req.body.name !== undefined && !name) throw new ApiError(400, 'name_required');
    if (cost === null || stock === null) throw new ApiError(400, 'invalid_reward');
    const { rows } = await pool.query(`
      UPDATE rewards SET
        name = COALESCE($2, name),
        points_cost = COALESCE($3, points_cost),
        stock = COALESCE($4, stock),
        active = COALESCE($5, active)
      WHERE id = $1
      RETURNING id, name, points_cost, stock, active
    `, [id, name, cost === undefined ? null : cost, stock === undefined ? null : stock,
        active === undefined ? null : active]);
    if (!rows.length) throw new ApiError(404, 'reward_not_found');
    res.json({ reward: rows[0] });
  } catch (err) { next(err); }
});

// Redeem: deduct points, decrement stock, open a pending redemption — all in
// one locked transaction, so a double-tap or two neighbors racing for the
// last item can never oversell it or spend points twice.
app.post('/api/rewards/:id/redeem', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    const result = await withTx(async (client) => {
      const m = await client.query(`SELECT * FROM members WHERE user_id = $1 FOR UPDATE`, [req.user.id]);
      const member = m.rows[0];
      const r = await client.query(`SELECT * FROM rewards WHERE id = $1 FOR UPDATE`, [id]);
      const reward = r.rows[0];
      if (!reward) throw new ApiError(404, 'reward_not_found');
      if (!reward.active) throw new ApiError(409, 'reward_unavailable');
      if (reward.stock <= 0) throw new ApiError(409, 'out_of_stock');
      if (member.points_balance < reward.points_cost) {
        throw new ApiError(409, 'insufficient_balance', {
          needed: reward.points_cost - member.points_balance,
        });
      }
      const up = await client.query(
        `UPDATE members SET points_balance = points_balance - $1 WHERE id = $2 RETURNING points_balance`,
        [reward.points_cost, member.id]
      );
      await client.query(`UPDATE rewards SET stock = stock - 1 WHERE id = $1`, [reward.id]);
      const red = await client.query(
        `INSERT INTO redemptions (member_id, reward_id, points_spent, created_at)
         VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [member.id, reward.id, reward.points_cost, req.now]
      );
      await client.query(
        `INSERT INTO point_transactions (member_id, delta, reason, ref_type, ref_id, created_at)
         VALUES ($1, $2, 'redemption', 'redemption', $3, $4)`,
        [member.id, -reward.points_cost, red.rows[0].id, req.now]
      );
      return {
        redemption: {
          id: red.rows[0].id,
          reward_id: reward.id,
          reward_name: reward.name,
          points_spent: reward.points_cost,
          status: 'pending',
          created_at: red.rows[0].created_at,
        },
        points_balance: up.rows[0].points_balance,
      };
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ── Deposits ────────────────────────────────────────────────────────────────

async function fetchDeposits(where, params, limit) {
  const { rows } = await pool.query(`
    SELECT d.id, d.member_id, d.recorded_by, d.total_points, d.voided, d.voided_at, d.created_at,
           m.display_name, m.username, m.house_no,
           rm.username AS recorded_by_username
    FROM deposits d JOIN members m ON m.id = d.member_id
    LEFT JOIN members rm ON rm.user_id = d.recorded_by
    ${where ? 'WHERE ' + where : ''}
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT $${params.length + 1}
  `, [...params, limit]);
  let items = [];
  if (rows.length) {
    const ir = await pool.query(
      `SELECT deposit_id, waste_type_id, label, weight_g, points
       FROM deposit_items WHERE deposit_id = ANY($1) ORDER BY id`,
      [rows.map(r => r.id)]
    );
    items = ir.rows;
  }
  return rows.map(r => ({
    id: r.id,
    member_id: r.member_id,
    total_points: r.total_points,
    voided: r.voided,
    voided_at: r.voided_at,
    created_at: r.created_at,
    recorded_by_username: r.recorded_by_username || null,
    member: { display_name: r.display_name, username: r.username, house_no: r.house_no },
    items: items.filter(i => i.deposit_id === r.id),
  }));
}

// Own history by default (guests get an empty list); admins may look across
// the neighborhood with ?all=1 or ?member_id=N. ?limit=N caps the count
// (Home shows the three most recent).
app.get('/api/deposits', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    let where = null;
    const params = [];
    if (req.query.member_id || req.query.all === '1') {
      const me = req.user ? await getMemberByUser(req.user.id) : null;
      if (!me || !me.is_admin) throw new ApiError(403, 'manager_only');
      if (req.query.member_id) { where = 'd.member_id = $1'; params.push(intParamReq(req.query.member_id)); }
    } else if (req.user) {
      const me = await getMemberByUser(req.user.id);
      where = 'd.member_id = $1';
      params.push(me.id);
    } else {
      // A guest has no member row: they see no deposit history, never
      // the neighborhood's.
      return res.json({ deposits: [] });
    }
    const deposits = await fetchDeposits(where, params, limit);
    res.json({ deposits });
  } catch (err) { next(err); }
});

function intParamReq(v) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, 'invalid_id');
  return n;
}

// Admin records a deposit for a member. Points are computed here from the
// CURRENT price and snapshotted, so later price edits never reprice history.
app.post('/api/deposits', requireAdmin, async (req, res, next) => {
  try {
    const memberId = cleanInt(req.body.member_id, 1, 2147483647);
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!memberId) throw new ApiError(400, 'member_required');
    if (!rawItems.length || rawItems.length > 20) throw new ApiError(400, 'items_required');
    const typeIds = rawItems.map(i => cleanInt(i && i.waste_type_id, 1, 2147483647));
    if (typeIds.some(t => t === null)) throw new ApiError(400, 'invalid_item');
    const types = await pool.query(
      `SELECT id, name, points_per_kg FROM waste_types WHERE id = ANY($1) AND active = TRUE`,
      [typeIds]
    );
    const byId = new Map(types.rows.map(t => [t.id, t]));
    const prepared = [];
    for (const item of rawItems) {
      const t = byId.get(cleanInt(item.waste_type_id, 1, 2147483647));
      if (!t) throw new ApiError(400, 'waste_type_unavailable');
      const weightG = cleanInt(item.weight_g, 1, 1000000000);
      if (weightG === null) throw new ApiError(400, 'invalid_weight');
      prepared.push({ waste_type_id: t.id, label: t.name, weight_g: weightG, points: pointsFor(weightG, t.points_per_kg) });
    }
    const total = prepared.reduce((s, i) => s + i.points, 0);
    const result = await withTx(async (client) => {
      const m = await client.query(`SELECT * FROM members WHERE id = $1 FOR UPDATE`, [memberId]);
      const member = m.rows[0];
      if (!member) throw new ApiError(404, 'member_not_found');
      const d = await client.query(
        `INSERT INTO deposits (member_id, recorded_by, total_points, created_at)
         VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
        [memberId, req.user.id, total, req.now]
      );
      const depositId = d.rows[0].id;
      for (const it of prepared) {
        await client.query(
          `INSERT INTO deposit_items (deposit_id, waste_type_id, label, weight_g, points) VALUES ($1, $2, $3, $4, $5)`,
          [depositId, it.waste_type_id, it.label, it.weight_g, it.points]
        );
      }
      const up = await client.query(
        `UPDATE members SET points_balance = points_balance + $1 WHERE id = $2 RETURNING points_balance`,
        [total, memberId]
      );
      await client.query(
        `INSERT INTO point_transactions (member_id, delta, reason, ref_type, ref_id, created_at)
         VALUES ($1, $2, 'deposit', 'deposit', $3, $4)`,
        [memberId, total, depositId, req.now]
      );
      return { deposit_id: depositId, created_at: d.rows[0].created_at, balance: up.rows[0].points_balance };
    });
    res.status(201).json({ ok: true, deposit_id: result.deposit_id, points_balance: result.balance, total_points: total });
  } catch (err) { next(err); }
});

// Void a mistyped deposit: reverse its points. Refused when the member has
// already spent them — the balance never goes negative.
app.post('/api/deposits/:id/void', requireAdmin, async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    await withTx(async (client) => {
      const d = await client.query(`SELECT * FROM deposits WHERE id = $1 FOR UPDATE`, [id]);
      const deposit = d.rows[0];
      if (!deposit) throw new ApiError(404, 'deposit_not_found');
      if (deposit.voided) throw new ApiError(409, 'already_voided');
      const m = await client.query(`SELECT * FROM members WHERE id = $1 FOR UPDATE`, [deposit.member_id]);
      const member = m.rows[0];
      if (member.points_balance < deposit.total_points) {
        throw new ApiError(409, 'insufficient_balance_to_void');
      }
      await client.query(`UPDATE deposits SET voided = TRUE, voided_at = $2 WHERE id = $1`, [id, req.now]);
      await client.query(
        `UPDATE members SET points_balance = points_balance - $1 WHERE id = $2`,
        [deposit.total_points, member.id]
      );
      await client.query(
        `INSERT INTO point_transactions (member_id, delta, reason, ref_type, ref_id, created_at)
         VALUES ($1, $2, 'void', 'deposit', $3, $4)`,
        [member.id, -deposit.total_points, id, req.now]
      );
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Redemptions ─────────────────────────────────────────────────────────────

app.get('/api/redemptions', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    let where = 'r.member_id = $1';
    const params = [];
    if (req.query.all === '1') {
      const me = req.user ? await getMemberByUser(req.user.id) : null;
      if (!me || !me.is_admin) throw new ApiError(403, 'manager_only');
      where = null;
    } else {
      if (!req.user) return res.json({ redemptions: [] });
      params.push((await getMemberByUser(req.user.id)).id);
    }
    const { rows } = await pool.query(`
      SELECT r.id, r.member_id, r.reward_id, r.points_spent, r.status, r.created_at, r.resolved_at,
             w.name AS reward_name, m.display_name, m.username, m.house_no
      FROM redemptions r
      JOIN rewards w ON w.id = r.reward_id
      JOIN members m ON m.id = r.member_id
      ${where ? 'WHERE ' + where : ''}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $${params.length + 1}
    `, [...params, limit]);
    res.json({
      redemptions: rows.map(r => ({
        id: r.id,
        member_id: r.member_id,
        reward_id: r.reward_id,
        reward_name: r.reward_name,
        points_spent: r.points_spent,
        status: r.status,
        created_at: r.created_at,
        resolved_at: r.resolved_at,
        member: { display_name: r.display_name, username: r.username, house_no: r.house_no },
      })),
    });
  } catch (err) { next(err); }
});

// Hand the reward over, or cancel it (refund points, return the item to
// stock — one transaction).
app.post('/api/redemptions/:id/resolve', requireAdmin, async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    const status = req.body.status;
    if (status !== 'picked_up' && status !== 'cancelled') throw new ApiError(400, 'invalid_status');
    await withTx(async (client) => {
      const r = await client.query(`SELECT * FROM redemptions WHERE id = $1 FOR UPDATE`, [id]);
      const redemption = r.rows[0];
      if (!redemption) throw new ApiError(404, 'redemption_not_found');
      if (redemption.status !== 'pending') throw new ApiError(409, 'already_resolved');
      if (status === 'picked_up') {
        await client.query(
          `UPDATE redemptions SET status = 'picked_up', handled_by = $2, resolved_at = $3 WHERE id = $1`,
          [id, req.user.id, req.now]
        );
        return;
      }
      await client.query(
        `UPDATE members SET points_balance = points_balance + $1 WHERE id = $2`,
        [redemption.points_spent, redemption.member_id]
      );
      await client.query(`UPDATE rewards SET stock = stock + 1 WHERE id = $1`, [redemption.reward_id]);
      await client.query(
        `UPDATE redemptions SET status = 'cancelled', handled_by = $2, resolved_at = $3 WHERE id = $1`,
        [id, req.user.id, req.now]
      );
      await client.query(
        `INSERT INTO point_transactions (member_id, delta, reason, ref_type, ref_id, created_at)
         VALUES ($1, $2, 'refund', 'redemption', $3, $4)`,
        [redemption.member_id, redemption.points_spent, id, req.now]
      );
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Members (admin) ─────────────────────────────────────────────────────────

app.get('/api/members', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.username, m.display_name, m.house_no, m.is_admin, m.points_balance, m.created_at,
             COALESCE(d.deposit_count, 0) AS deposit_count
      FROM members m
      LEFT JOIN (
        SELECT member_id, COUNT(*) AS deposit_count FROM deposits WHERE voided = FALSE GROUP BY member_id
      ) d ON d.member_id = m.id
      ORDER BY m.created_at
    `);
    res.json({ members: rows });
  } catch (err) { next(err); }
});

app.patch('/api/members/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    const { rows } = await pool.query(`SELECT * FROM members WHERE id = $1`, [id]);
    const target = rows[0];
    if (!target) throw new ApiError(404, 'member_not_found');
    if ('is_admin' in req.body && !req.body.is_admin && target.user_id === req.user.id) {
      throw new ApiError(409, 'cannot_demote_self');
    }
    // Fields sent in the body are SET (an empty string clears them); fields
    // left out keep their current value. is_admin keeps its three-state
    // handling because it is a boolean, never a "clear".
    const displayName = 'display_name' in req.body ? cleanText(req.body.display_name, 120) : target.display_name;
    const houseNo = 'house_no' in req.body ? cleanText(req.body.house_no, 120) : target.house_no;
    const phone = 'phone' in req.body ? cleanText(req.body.phone, 40) : target.phone;
    const isAdmin = 'is_admin' in req.body ? !!req.body.is_admin : target.is_admin;
    await pool.query(`
      UPDATE members SET
        display_name = $2, house_no = $3, phone = $4, is_admin = $5
      WHERE id = $1
    `, [id, displayName, houseNo, phone, isAdmin]);
    const updated = await pool.query(`
      SELECT m.id, m.username, m.display_name, m.house_no, m.phone, m.is_admin, m.points_balance FROM members m WHERE id = $1
    `, [id]);
    res.json({ member: memberJson(updated.rows[0]) });
  } catch (err) { next(err); }
});

// API errors with a stable code; anything else is unexpected → 500.
app.use((err, req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json(Object.assign({ error: err.code }, err.extra));
  }
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/reloop-a41163/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/reloop-a41163/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await migrate();
  if (IS_STAGING) await seedStaging();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  server.keepAliveTimeout = 75_000;

  // The platform sends SIGTERM on redeploy: stop accepting connections,
  // drain in-flight requests for ~3 s, close the pool, exit.
  let shuttingDown = false;
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    pool.end().catch(() => {}).finally(() => process.exit(0));
  }
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutdown signal received, draining…');
    server.close(finish);
    setTimeout(finish, 3000);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
