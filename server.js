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

// ── ReLoop — neighborhood reuse ─────────────────────────────────────────────
//
// One neighborhood. Neighbors post second-hand things they no longer need
// (Free, Swap, or a low price paid in person), others ask for them, and both
// sides mark the handover done. Every completed loop is one item kept out of
// the waste stream. Moderators review reports and can hide an item from the
// feed.
//
// The first moderator promotes themselves once with a shared setup code
// (ADMIN_SETUP_CODE, configured in the app's Secrets); after that moderators
// manage each other. Guest visitors can read the feed; every write needs an
// account, which the platform's auth middleware above already enforces.

// The shared secret the neighborhood's first moderator uses once to claim the
// role. Declared in dapp.json's secrets; unset value = setup not available.
const ADMIN_SETUP_CODE = process.env.ADMIN_SETUP_CODE || '';

// The fixed pickup areas of the one neighborhood. Distance between two items
// is counted in blocks between areas, never from the phone's location.
const AREAS = ['RT 01', 'RT 02', 'RT 03', 'RT 04', 'RT 05', 'RT 06', 'RT 07', 'RT 08'];
const CATEGORIES = ['clothes', 'electronics', 'furniture', 'books', 'kitchen'];
const CONDITIONS = ['like_new', 'good', 'worn'];
const LISTING_TYPES = ['free', 'swap', 'price'];
// A typical weight per category, in integer grams, for the "estimated kg of
// waste avoided" figure. Always labelled an estimate where it shows.
const EST_GRAMS = { clothes: 500, electronics: 2000, furniture: 15000, books: 1000, kitchen: 1000 };
const REPORT_REASONS = ['not_secondhand', 'inappropriate', 'spam', 'other'];

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
// Public tables: `items` and `item_photos` (the feed a stranger may read).
//
// Private tables (`staging:private` — staging copies them schema-only):
// `members` (pickup areas and account data), `item_requests` (personal
// messages between neighbors) and `item_reports` (moderation). No public
// table carries a foreign key to a private one.
//
// The old waste-bank tables (waste_types, rewards, deposits, deposit_items,
// redemptions, point_transactions, collection_schedule) are left in place and
// unused, so nobody's deposit history is destroyed by the redesign. They stay
// private.
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
  // 'kg' types are priced per kilogram; 'item' types (usable goods) per piece.
  // points_per_kg holds the price per unit either way.
  await pool.query(`ALTER TABLE waste_types ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'kg'`);
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
  // Opt-out of the monthly leaderboard the waste bank had (unused now).
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS leaderboard_opt_out BOOLEAN`);
  // The pickup area the viewer chose: one of AREAS, or NULL when unset.
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pickup_area TEXT`);
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
  await pool.query(`ALTER TABLE deposit_items ADD COLUMN IF NOT EXISTS quantity INTEGER`);
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collection_schedule (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      days SMALLINT[] NOT NULL,
      open_time TEXT NOT NULL,
      close_time TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // The reuse feed. Owners are Homeroom user ids, stored without a foreign
  // key (matching members.user_id), never a link into a private table.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      owner_name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      condition TEXT NOT NULL CHECK (condition IN ('like_new','good','worn')),
      category TEXT NOT NULL CHECK (category IN ('clothes','electronics','furniture','books','kitchen')),
      area TEXT NOT NULL,
      listing_type TEXT NOT NULL CHECK (listing_type IN ('free','swap','price')),
      price_idr INTEGER,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','done')),
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      done_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS item_photos (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      file_id TEXT,
      position SMALLINT NOT NULL,
      UNIQUE (item_id, position)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS item_requests (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id),
      requester_user_id INTEGER NOT NULL,
      requester_name TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (item_id, requester_user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS item_reports (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id),
      reporter_user_id INTEGER NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('not_secondhand','inappropriate','spam','other')),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolution TEXT CHECK (resolution IN ('hidden','kept'))
    )
  `);

  for (const t of ['members', 'deposits', 'deposit_items', 'redemptions', 'point_transactions', 'item_requests', 'item_reports']) {
    await pool.query(`COMMENT ON TABLE ${t} IS 'staging:private'`);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS deposits_member_created ON deposits (member_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS redemptions_member_created ON redemptions (member_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS point_tx_member ON point_transactions (member_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS items_feed ON items (status, hidden, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS items_owner ON items (owner_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS item_requests_requester ON item_requests (requester_user_id, created_at DESC)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS item_reports_open ON item_reports (item_id, reporter_user_id) WHERE resolved_at IS NULL`);
}

// ── Staging seed data ───────────────────────────────────────────────────────
//
// Runs on every staging boot, idempotent, obviously fake ("Staging demo …"),
// fixed high ids so real rows can never collide. Fake people only: never a
// row owned by whoever opens the preview, so My Loops and personal Impact
// show the honest empty state. Seeded items carry no photo rows, so the
// bundled category artwork shows.
async function seedStaging() {
  // Fake platform identities, kept off the ids the platform uses for whoever
  // opens a preview or for the proposal checks' sign-in.
  const members = [
    [910001, 'staging-demo-sari', 'Sari (demo)', 'RT 03'],
    [910002, 'staging-demo-budi', 'Budi (demo)', 'RT 04'],
    [910003, 'staging-demo-dewi', 'Dewi (demo)', 'RT 05'],
    [910004, 'staging-demo-agus', 'Agus (demo)', 'RT 01'],
    [910005, 'staging-demo-rina', 'Rina (demo)', 'RT 02'],
    [910006, 'staging-demo-joko', 'Joko (demo)', 'RT 06'],
  ];
  for (const [id, username, displayName, area] of members) {
    await pool.query(
      `INSERT INTO members (id, user_id, username, display_name, pickup_area, is_admin)
       VALUES ($1, $1, $2, $3, $4, FALSE) ON CONFLICT (user_id) DO NOTHING`,
      [id, username, displayName, area]
    );
  }
  // [id, owner user id, title, description, condition, category, area, type, price, status, days ago]
  const items = [
    [900001, 910001, 'Denim jacket', 'Size M, worn a few times. Pick up after 5 pm.', 'good', 'clothes', 'RT 03', 'free', null, 'available', 2],
    [900002, 910002, 'Novels, set of 4', 'Good condition, all four together.', 'like_new', 'books', 'RT 04', 'swap', null, 'available', 3],
    [900003, 910003, 'Bookshelf', 'Three shelves, one side a little scratched.', 'worn', 'furniture', 'RT 05', 'price', 50000, 'available', 4],
    [900004, 910004, 'Rice cooker', 'Works well, small size.', 'good', 'kitchen', 'RT 01', 'free', null, 'available', 5],
    [900005, 910005, 'Desk fan', 'Quiet, good for a study desk.', 'good', 'electronics', 'RT 02', 'price', 75000, 'available', 5],
    [900006, 910006, 'School uniforms', 'Two sets, primary school size.', 'good', 'clothes', 'RT 06', 'swap', null, 'available', 6],
    [900007, 910002, 'Frying pan', 'Non-stick surface is still fine.', 'worn', 'kitchen', 'RT 04', 'free', null, 'available', 7],
    [900008, 910001, 'Study desk', 'Solid wood, small mark on the top.', 'good', 'furniture', 'RT 03', 'price', 150000, 'available', 8],
    [900009, 910004, 'Radio', 'Old but it still runs on batteries.', 'worn', 'electronics', 'RT 01', 'free', null, 'available', 9],
    [900010, 910003, "Kids' raincoat", 'Yellow, size 8 to 10, never worn.', 'like_new', 'clothes', 'RT 05', 'swap', null, 'available', 10],
    [900011, 910005, 'Blender', 'Jug and lid included.', 'good', 'kitchen', 'RT 02', 'price', 60000, 'available', 11],
    [900012, 910006, 'Standing lamp', 'Reserved for Sari.', 'like_new', 'furniture', 'RT 06', 'free', null, 'reserved', 12],
    [900013, 910002, 'Dining chairs', 'Two chairs, given to Dewi.', 'good', 'furniture', 'RT 04', 'free', null, 'done', 20],
    [900014, 910004, 'Bread toaster', 'Swapped with Rina, works fine.', 'good', 'kitchen', 'RT 01', 'swap', null, 'done', 24],
    [900015, 910001, 'Fleece blanket', 'Given to Joko.', 'good', 'clothes', 'RT 03', 'free', null, 'done', 30],
  ];
  for (const [id, owner, title, desc, cond, cat, area, type, price, status, daysAgo] of items) {
    const ownerName = members.find(m => m[0] === owner)[2];
    await pool.query(
      `INSERT INTO items (id, owner_user_id, owner_name, title, description, condition, category,
                          area, listing_type, price_idr, status, created_at, done_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               NOW() - make_interval(days => $12),
               CASE WHEN $11 = 'done' THEN NOW() - make_interval(days => $12) ELSE NULL END)
       ON CONFLICT (id) DO NOTHING`,
      [id, owner, ownerName, 'Staging demo: ' + title, desc, cond, cat, area, type, price, status, daysAgo]
    );
  }
  // [id, item id, requester user id, message, status, days ago]
  const requests = [
    [900001, 900001, 910002, 'Could I pick it up on Saturday morning?', 'pending', 1],
    [900002, 900002, 910005, 'I can swap a set of cookbooks for these.', 'pending', 2],
    [900003, 900008, 910004, 'Is Sunday afternoon okay?', 'pending', 3],
    [900004, 900012, 910001, 'I can collect it this evening.', 'accepted', 4],
    [900005, 900013, 910003, 'These would be perfect, thank you.', 'accepted', 19],
    [900006, 900014, 910005, 'Swapped today, thank you.', 'accepted', 23],
    [900007, 900015, 910006, 'Picked it up last week.', 'accepted', 29],
    [900008, 900003, 910001, 'Maybe next month instead.', 'declined', 4],
  ];
  for (const [id, itemId, requester, message, status, daysAgo] of requests) {
    const name = members.find(m => m[0] === requester)[2];
    await pool.query(
      `INSERT INTO item_requests (id, item_id, requester_user_id, requester_name, message, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() - make_interval(days => $7), NOW() - make_interval(days => $7))
       ON CONFLICT (id) DO NOTHING`,
      [id, itemId, requester, name, message, status, daysAgo]
    );
  }
  // One open report, so a moderator in staging sees the Reports list.
  await pool.query(
    `INSERT INTO item_reports (id, item_id, reporter_user_id, reason, note, created_at)
     VALUES (900001, 900009, 910003, 'not_secondhand', 'This looks like a shop listing.', NOW() - make_interval(days => 1))
     ON CONFLICT (id) DO NOTHING`
  );
  // Explicit ids bypass the sequences; push each sequence past the highest
  // seeded id so real inserts can never collide with demo rows.
  for (const t of ['waste_types', 'rewards', 'members', 'deposits', 'deposit_items', 'redemptions',
    'point_transactions', 'items', 'item_photos', 'item_requests', 'item_reports']) {
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

function getMemberByUser(userId) {
  return pool.query(
    `SELECT id, user_id, username, display_name, pickup_area, is_admin
     FROM members WHERE user_id = $1`, [userId]
  ).then(r => r.rows[0] || null);
}

// Every authenticated /api request lazily provisions the caller's member row
// (resident). Production-shaped: nothing seeds real visitors.
app.use('/api', (req, res, next) => {
  if (!req.user) return next();
  pool.query(
    `INSERT INTO members (user_id, username) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
    [req.user.id, req.user.username]
  ).then(() => next(), next);
});

// Moderator gate. The waste bank manager role became the neighborhood's
// moderator role; the same setup code promotes the first one.
async function requireAdmin(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const member = await getMemberByUser(req.user.id);
    if (!member || !member.is_admin) return res.status(403).json({ error: 'moderator_only' });
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
    pickup_area: m.pickup_area || null,
    is_admin: m.is_admin,
  };
}

function itemJson(r) {
  return {
    id: r.id,
    owner_user_id: r.owner_user_id,
    owner_name: r.owner_name,
    title: r.title,
    description: r.description,
    condition: r.condition,
    category: r.category,
    area: r.area,
    listing_type: r.listing_type,
    price_idr: r.price_idr === null || r.price_idr === undefined ? null : r.price_idr,
    status: r.status,
    hidden: r.hidden === true,
    created_at: r.created_at,
    done_at: r.done_at || null,
    photo_url: r.photo_url || null,
  };
}

const PHOTO_URL_RE = /^https:\/\/[^/\s]+\/app-files\/[0-9a-f]{32}$/;
const PHOTO_ID_RE = /^[0-9a-f]{32}$/;

function cleanPhotos(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, 3) : [];
  const out = [];
  for (const p of list) {
    const url = p && typeof p.url === 'string' ? p.url : '';
    const id = p && typeof p.id === 'string' ? p.id : '';
    if (!PHOTO_URL_RE.test(url) || !PHOTO_ID_RE.test(id)) throw new ApiError(400, 'invalid_photo');
    out.push({ url, id, position: out.length });
  }
  return out;
}

function estGramsFor(category) {
  return EST_GRAMS[category] || 1000;
}

// ── Me ──────────────────────────────────────────────────────────────────────

app.get('/api/me', async (req, res, next) => {
  try {
    const setupConfigured = !!ADMIN_SETUP_CODE;
    const constants = {
      setup_configured: setupConfigured,
      areas: AREAS,
      categories: CATEGORIES,
      conditions: CONDITIONS,
      est_grams: EST_GRAMS,
    };
    if (!req.user) return res.json(Object.assign({ guest: true, member: null }, constants));
    const m = await getMemberByUser(req.user.id);
    if (!m) throw new ApiError(500, 'member_missing');
    res.json(Object.assign({ guest: false, member: memberJson(m) }, constants));
  } catch (err) { next(err); }
});

app.patch('/api/me', async (req, res, next) => {
  try {
    const m = await getMemberByUser(req.user.id);
    if (!m) throw new ApiError(500, 'member_missing');
    const displayName = 'display_name' in req.body ? cleanText(req.body.display_name, 120) : m.display_name;
    let area = m.pickup_area || null;
    if ('pickup_area' in req.body) {
      const raw = typeof req.body.pickup_area === 'string' ? req.body.pickup_area.trim() : '';
      if (!raw) area = null;
      else if (AREAS.includes(raw)) area = raw;
      else throw new ApiError(400, 'invalid_area');
    }
    await withTx(async (client) => {
      await client.query(
        `UPDATE members SET display_name = $2, pickup_area = $3 WHERE id = $1`,
        [m.id, displayName, area]
      );
      // The name people see on an item or a request follows the new name.
      const shown = displayName || m.username;
      await client.query(`UPDATE items SET owner_name = $2 WHERE owner_user_id = $1`, [m.user_id, shown]);
      await client.query(`UPDATE item_requests SET requester_name = $2 WHERE requester_user_id = $1`, [m.user_id, shown]);
    });
    res.json({ member: memberJson(await getMemberByUser(req.user.id)) });
  } catch (err) { next(err); }
});

// One-time self-promotion for the neighborhood's first moderator.
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

// ── Items: the feed ─────────────────────────────────────────────────────────

app.get('/api/items', async (req, res, next) => {
  try {
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
    const rawType = req.query.type;
    const type = ['free', 'swap', 'cheap'].includes(rawType) ? rawType : null;
    const listingType = type === 'cheap' ? 'price' : type;
    const { rows } = await pool.query(`
      SELECT i.*, p.url AS photo_url
      FROM items i
      LEFT JOIN item_photos p ON p.item_id = i.id AND p.position = 0
      WHERE i.status = 'available' AND i.hidden = FALSE
        AND ($1::text IS NULL OR i.category = $1)
        AND ($2::text IS NULL OR i.listing_type = $2)
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT 100
    `, [category, listingType]);
    res.json({ items: rows.map(itemJson) });
  } catch (err) { next(err); }
});

app.get('/api/items/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(404, 'item_not_found');
    const { rows } = await pool.query(`SELECT * FROM items WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) throw new ApiError(404, 'item_not_found');
    const me = req.user ? await getMemberByUser(req.user.id) : null;
    const isOwner = !!(me && row.owner_user_id === me.user_id);
    const isModerator = !!(me && me.is_admin);
    // A hidden item disappears for everyone except its owner and moderators.
    if (row.hidden && !isOwner && !isModerator) throw new ApiError(404, 'item_not_found');

    const photos = await pool.query(
      `SELECT id, url, file_id, position FROM item_photos WHERE item_id = $1 ORDER BY position`, [id]
    );
    const item = itemJson(row);
    item.photos = photos.rows;

    const out = { item, is_owner: isOwner, my_request: null, reported_by_me: false };
    if (me) {
      const mr = await pool.query(
        `SELECT id, message, status, created_at, updated_at FROM item_requests
         WHERE item_id = $1 AND requester_user_id = $2`, [id, me.user_id]
      );
      out.my_request = mr.rows[0] || null;
      const rp = await pool.query(
        `SELECT 1 FROM item_reports WHERE item_id = $1 AND reporter_user_id = $2 AND resolved_at IS NULL`,
        [id, me.user_id]
      );
      out.reported_by_me = rp.rows.length > 0;
    }
    if (isOwner) {
      const rq = await pool.query(
        `SELECT id, requester_user_id, requester_name, message, status, created_at
         FROM item_requests WHERE item_id = $1
         ORDER BY (status = 'pending') DESC, created_at ASC`, [id]
      );
      out.requests = rq.rows;
    }
    res.json(out);
  } catch (err) { next(err); }
});

app.post('/api/items', async (req, res, next) => {
  try {
    const body = req.body || {};
    const title = cleanText(body.title, 80);
    if (!title || title.length < 3) throw new ApiError(400, 'invalid_title');
    const description = cleanText(body.description, 300);
    const condition = CONDITIONS.includes(body.condition) ? body.condition : null;
    if (!condition) throw new ApiError(400, 'invalid_condition');
    const category = CATEGORIES.includes(body.category) ? body.category : null;
    if (!category) throw new ApiError(400, 'invalid_category');
    const area = AREAS.includes(body.area) ? body.area : null;
    if (!area) throw new ApiError(400, 'invalid_area');
    const listingType = LISTING_TYPES.includes(body.listing_type) ? body.listing_type : null;
    if (!listingType) throw new ApiError(400, 'invalid_listing_type');
    let priceIdr = null;
    if (listingType === 'price') {
      priceIdr = cleanInt(body.price_idr, 1000, 1000000);
      if (priceIdr === null) throw new ApiError(400, 'invalid_price');
    }
    const photos = cleanPhotos(body.photos);
    const me = await getMemberByUser(req.user.id);
    if (!me) throw new ApiError(500, 'member_missing');
    const ownerName = me.display_name || me.username;

    const itemId = await withTx(async (client) => {
      const ins = await client.query(
        `INSERT INTO items (owner_user_id, owner_name, title, description, condition, category,
                            area, listing_type, price_idr, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [me.user_id, ownerName, title, description, condition, category, area, listingType, priceIdr, req.now]
      );
      const id = ins.rows[0].id;
      for (const p of photos) {
        await client.query(
          `INSERT INTO item_photos (item_id, url, file_id, position) VALUES ($1, $2, $3, $4)`,
          [id, p.url, p.id, p.position]
        );
      }
      return id;
    });
    res.status(201).json({ item: { id: itemId } });
  } catch (err) { next(err); }
});

// The owner moves an item between statuses: a handover happened (done), or a
// pickup fell through (back to available).
app.post('/api/items/:id/status', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    const status = req.body.status;
    if (status !== 'done' && status !== 'available') throw new ApiError(400, 'invalid_status');
    await withTx(async (client) => {
      const r = await client.query(`SELECT * FROM items WHERE id = $1 FOR UPDATE`, [id]);
      const item = r.rows[0];
      if (!item) throw new ApiError(404, 'item_not_found');
      if (item.owner_user_id !== req.user.id) throw new ApiError(403, 'not_owner');
      if (status === 'done') {
        if (item.status !== 'available' && item.status !== 'reserved') {
          throw new ApiError(409, 'invalid_transition');
        }
        await client.query(`UPDATE items SET status = 'done', done_at = $2 WHERE id = $1`, [id, req.now]);
        return;
      }
      // available again
      if (item.status !== 'reserved') throw new ApiError(409, 'invalid_transition');
      await client.query(`UPDATE items SET status = 'available' WHERE id = $1`, [id]);
      await client.query(
        `UPDATE item_requests SET status = 'declined', updated_at = $2
         WHERE item_id = $1 AND status = 'accepted'`, [id, req.now]
      );
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Requests ────────────────────────────────────────────────────────────────

app.post('/api/items/:id/requests', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    const message = cleanText(req.body.message, 200);
    if (!message) throw new ApiError(400, 'message_required');
    const { rows } = await pool.query(`SELECT * FROM items WHERE id = $1`, [id]);
    const item = rows[0];
    if (!item) throw new ApiError(404, 'item_not_found');
    if (item.owner_user_id === req.user.id) throw new ApiError(409, 'own_item');
    if (item.status !== 'available' || item.hidden) throw new ApiError(409, 'not_available');
    const me = await getMemberByUser(req.user.id);
    if (!me) throw new ApiError(500, 'member_missing');
    const name = me.display_name || me.username;
    const existing = await pool.query(
      `SELECT id, status FROM item_requests WHERE item_id = $1 AND requester_user_id = $2`,
      [id, me.user_id]
    );
    if (existing.rows.length) {
      const cur = existing.rows[0];
      if (cur.status === 'pending' || cur.status === 'accepted') throw new ApiError(409, 'already_requested');
      await pool.query(
        `UPDATE item_requests SET message = $2, requester_name = $3, status = 'pending', updated_at = $4
         WHERE id = $1`, [cur.id, message, name, req.now]
      );
      return res.status(201).json({ request: { id: cur.id, status: 'pending' } });
    }
    const ins = await pool.query(
      `INSERT INTO item_requests (item_id, requester_user_id, requester_name, message, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
      [id, me.user_id, name, message, req.now]
    );
    res.status(201).json({ request: { id: ins.rows[0].id, status: 'pending' } });
  } catch (err) { next(err); }
});

async function loadRequestForOwner(client, req, requestId) {
  const r = await client.query(`SELECT * FROM item_requests WHERE id = $1 FOR UPDATE`, [requestId]);
  const request = r.rows[0];
  if (!request) throw new ApiError(404, 'request_not_found');
  return request;
}

app.post('/api/requests/:id/accept', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    await withTx(async (client) => {
      const request = await loadRequestForOwner(client, req, id);
      const ir = await client.query(`SELECT * FROM items WHERE id = $1 FOR UPDATE`, [request.item_id]);
      const item = ir.rows[0];
      if (!item) throw new ApiError(404, 'item_not_found');
      if (item.owner_user_id !== req.user.id) throw new ApiError(403, 'not_owner');
      if (item.status !== 'available') throw new ApiError(409, 'not_available');
      if (request.status !== 'pending') throw new ApiError(409, 'invalid_transition');
      await client.query(
        `UPDATE item_requests SET status = 'accepted', updated_at = $2 WHERE id = $1`, [id, req.now]
      );
      await client.query(`UPDATE items SET status = 'reserved' WHERE id = $1`, [item.id]);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/requests/:id/decline', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    await withTx(async (client) => {
      const request = await loadRequestForOwner(client, req, id);
      const ir = await client.query(`SELECT * FROM items WHERE id = $1`, [request.item_id]);
      const item = ir.rows[0];
      if (!item) throw new ApiError(404, 'item_not_found');
      if (item.owner_user_id !== req.user.id) throw new ApiError(403, 'not_owner');
      if (request.status !== 'pending') throw new ApiError(409, 'invalid_transition');
      await client.query(
        `UPDATE item_requests SET status = 'declined', updated_at = $2 WHERE id = $1`, [id, req.now]
      );
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/requests/:id/cancel', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    await withTx(async (client) => {
      const request = await loadRequestForOwner(client, req, id);
      if (request.requester_user_id !== req.user.id) throw new ApiError(403, 'not_requester');
      const ir = await client.query(`SELECT * FROM items WHERE id = $1 FOR UPDATE`, [request.item_id]);
      const item = ir.rows[0];
      if (!item) throw new ApiError(404, 'item_not_found');
      if (request.status === 'pending') {
        await client.query(
          `UPDATE item_requests SET status = 'cancelled', updated_at = $2 WHERE id = $1`, [id, req.now]
        );
        return;
      }
      // An accepted request can be cancelled only while the item is still
      // reserved, which frees the item again. A done loop can't be undone.
      if (request.status === 'accepted' && item.status === 'reserved') {
        await client.query(
          `UPDATE item_requests SET status = 'cancelled', updated_at = $2 WHERE id = $1`, [id, req.now]
        );
        await client.query(`UPDATE items SET status = 'available' WHERE id = $1`, [item.id]);
        return;
      }
      throw new ApiError(409, 'invalid_transition');
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── My Loops ────────────────────────────────────────────────────────────────

app.get('/api/my/items', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.*,
             (SELECT url FROM item_photos p WHERE p.item_id = i.id AND p.position = 0) AS photo_url,
             (SELECT COUNT(*)::int FROM item_requests r WHERE r.item_id = i.id AND r.status = 'pending') AS pending_count,
             (SELECT requester_name FROM item_requests r WHERE r.item_id = i.id AND r.status = 'accepted' LIMIT 1) AS accepted_name
      FROM items i
      WHERE i.owner_user_id = $1
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT 200
    `, [req.user.id]);
    res.json({
      items: rows.map(r => Object.assign(itemJson(r), {
        pending_count: r.pending_count,
        accepted_name: r.accepted_name || null,
      })),
    });
  } catch (err) { next(err); }
});

app.get('/api/my/requests', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.item_id, r.message, r.status, r.created_at,
             i.title, i.status AS item_status, i.hidden, i.owner_name, i.category,
             (SELECT url FROM item_photos p WHERE p.item_id = i.id AND p.position = 0) AS photo_url
      FROM item_requests r
      JOIN items i ON i.id = r.item_id
      WHERE r.requester_user_id = $1
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 200
    `, [req.user.id]);
    res.json({
      requests: rows.map(r => ({
        id: r.id,
        item_id: r.item_id,
        message: r.message,
        status: r.status,
        created_at: r.created_at,
        item_unavailable: r.hidden === true,
        title: r.hidden ? null : r.title,
        category: r.hidden ? null : r.category,
        item_status: r.hidden ? null : r.item_status,
        owner_name: r.hidden ? null : r.owner_name,
        photo_url: r.hidden ? null : r.photo_url,
      })),
    });
  } catch (err) { next(err); }
});

// ── Impact ──────────────────────────────────────────────────────────────────

app.get('/api/impact', async (req, res, next) => {
  try {
    const hood = await pool.query(
      `SELECT id, category FROM items WHERE status = 'done' AND hidden = FALSE`
    );
    const neighbourhood = {
      loops: hood.rows.length,
      grams: hood.rows.reduce((s, r) => s + estGramsFor(r.category), 0),
    };
    let you = null;
    if (req.user) {
      // A completed loop counts once for the owner and once for the person
      // whose request was accepted. UNION dedupes an item counted both ways.
      const mine = await pool.query(`
        SELECT id, category FROM items WHERE status = 'done' AND owner_user_id = $1
        UNION
        SELECT i.id, i.category FROM items i
        JOIN item_requests r ON r.item_id = i.id
        WHERE i.status = 'done' AND r.requester_user_id = $1 AND r.status = 'accepted'
      `, [req.user.id]);
      you = {
        loops: mine.rows.length,
        grams: mine.rows.reduce((s, r) => s + estGramsFor(r.category), 0),
      };
    }
    res.json({ neighbourhood, you, badge_size: 5 });
  } catch (err) { next(err); }
});

// ── Reports (everyone) ──────────────────────────────────────────────────────

app.post('/api/items/:id/report', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    const reason = REPORT_REASONS.includes(req.body.reason) ? req.body.reason : null;
    if (!reason) throw new ApiError(400, 'invalid_reason');
    const note = cleanText(req.body.note, 200);
    const { rows } = await pool.query(`SELECT * FROM items WHERE id = $1`, [id]);
    const item = rows[0];
    if (!item || item.hidden) throw new ApiError(404, 'item_not_found');
    if (item.owner_user_id === req.user.id) throw new ApiError(409, 'own_item');
    const open = await pool.query(
      `SELECT id FROM item_reports WHERE item_id = $1 AND reporter_user_id = $2 AND resolved_at IS NULL`,
      [id, req.user.id]
    );
    // A second open report from the same person is already recorded.
    if (open.rows.length) return res.json({ ok: true });
    await pool.query(
      `INSERT INTO item_reports (item_id, reporter_user_id, reason, note, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, req.user.id, reason, note, req.now]
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// ── Moderation ──────────────────────────────────────────────────────────────

app.get('/api/reports', requireAdmin, async (req, res, next) => {
  try {
    const [groups, details] = await Promise.all([
      pool.query(`
        SELECT i.id AS item_id, i.title, i.owner_name, i.hidden,
               COUNT(r.id)::int AS report_count, MIN(r.created_at) AS first_at,
               (SELECT url FROM item_photos p WHERE p.item_id = i.id AND p.position = 0) AS photo_url
        FROM item_reports r
        JOIN items i ON i.id = r.item_id
        WHERE r.resolved_at IS NULL
        GROUP BY i.id
        ORDER BY MIN(r.created_at) ASC, i.id ASC
      `),
      pool.query(`
        SELECT item_id, reason, note FROM item_reports
        WHERE resolved_at IS NULL ORDER BY created_at ASC, id ASC
      `),
    ]);
    res.json({
      reports: groups.rows.map(g => ({
        item_id: g.item_id,
        title: g.title,
        owner_name: g.owner_name,
        hidden: g.hidden,
        photo_url: g.photo_url || null,
        report_count: g.report_count,
        reports: details.rows
          .filter(d => d.item_id === g.item_id)
          .map(d => ({ reason: d.reason, note: d.note })),
      })),
    });
  } catch (err) { next(err); }
});

app.post('/api/reports/items/:itemId/resolve', requireAdmin, async (req, res, next) => {
  try {
    const itemId = intParam(req, 'itemId');
    const action = req.body.action;
    if (action !== 'hide' && action !== 'keep') throw new ApiError(400, 'invalid_action');
    await withTx(async (client) => {
      const r = await client.query(`SELECT id FROM items WHERE id = $1 FOR UPDATE`, [itemId]);
      if (!r.rows.length) throw new ApiError(404, 'item_not_found');
      if (action === 'hide') {
        await client.query(`UPDATE items SET hidden = TRUE WHERE id = $1`, [itemId]);
      }
      await client.query(
        `UPDATE item_reports SET resolved_at = $2, resolution = $3
         WHERE item_id = $1 AND resolved_at IS NULL`,
        [itemId, req.now, action === 'hide' ? 'hidden' : 'kept']
      );
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Members (moderators) ────────────────────────────────────────────────────

app.get('/api/members', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, username, display_name, is_admin FROM members ORDER BY created_at, id`
    );
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
    const isAdmin = 'is_admin' in req.body ? !!req.body.is_admin : target.is_admin;
    const updated = await pool.query(
      `UPDATE members SET is_admin = $2 WHERE id = $1
       RETURNING id, username, display_name, is_admin`,
      [id, isAdmin]
    );
    res.json({ member: updated.rows[0] });
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
