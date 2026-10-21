const express = require('express');
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

// Erasing and exporting a person's rows when they delete their Homeroom
// account. The platform sends those two requests with a token of its own
// (`x-usernode-platform-token`), never a person's sign-in token, so they are
// mounted here — before the sign-in check below.
require('./usernode-user-data')(app, pool);

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
// wherever they decide what shows. Production always gets the real time. A
// staging preview may be shown as of a chosen moment: the platform opens it
// with `?un-now=<ISO time>`, and the page sends `usernode.now()` on as the
// `x-usernode-now` header. Only a staging container reads either.
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

// ── ReLoop — one neighborhood's exchange ───────────────────────────────────
//
// Neighbors post things they no longer need — for free, to swap, or cheap —
// and ask each other for them. One post is one "loop": Available, then
// Reserved when the owner accepts a request, then Done once it has changed
// hands. Impact counts the loops that closed and the grams of waste they
// kept out of the bin.
//
// Weights are integer grams, never floats: a post's estimated weight comes
// from its category (CATEGORY_WEIGHT_G), so Impact can report kilograms
// without asking anybody to weigh anything.

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

// Pickup areas: the RTs of the one neighborhood this app serves, laid along
// its street. The walk between neighboring RTs is about ZONE_SPACING_M, so
// the feed can show how far an item is without asking anyone for their
// location.
const ZONES = [
  { id: 'rt01', label: 'RT 01' },
  { id: 'rt02', label: 'RT 02' },
  { id: 'rt03', label: 'RT 03' },
  { id: 'rt04', label: 'RT 04' },
  { id: 'rt05', label: 'RT 05' },
  { id: 'rt06', label: 'RT 06' },
];
const ZONE_IDS = ZONES.map(z => z.id);
const ZONE_SPACING_M = 150;

const CATEGORIES = [
  { id: 'clothes', label: 'Clothes' },
  { id: 'electronics', label: 'Electronics' },
  { id: 'furniture', label: 'Furniture' },
  { id: 'books', label: 'Books' },
  { id: 'kitchen', label: 'Kitchen' },
];
const CATEGORY_IDS = new Set(CATEGORIES.map(c => c.id));

// A rough weight per category, in grams, used only to estimate the waste an
// item keeps out of the bin. Deliberately coarse: it is a story, not a scale.
const CATEGORY_WEIGHT_G = {
  clothes: 500,
  electronics: 2000,
  furniture: 15000,
  books: 1000,
  kitchen: 1500,
};

const CONDITIONS = [
  { id: 'like_new', label: 'Like new' },
  { id: 'good', label: 'Good' },
  { id: 'worn', label: 'Worn' },
];
const CONDITION_IDS = new Set(CONDITIONS.map(c => c.id));

const LISTING_TYPES = [
  { id: 'free', label: 'Free' },
  { id: 'swap', label: 'Swap' },
  { id: 'cheap', label: 'Cheap' },
];
const LISTING_TYPE_IDS = new Set(LISTING_TYPES.map(t => t.id));

const REPORT_REASONS = new Set(['prohibited', 'spam', 'misleading', 'other']);
// An item is hidden from the feed once this many different people report it.
const REPORT_HIDE_AT = 3;

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template shipped no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Schema (idempotent, applied on boot) ────────────────────────────────────
//
// Public tables: `items` and `item_photos` — the neighborhood's listings,
// which every resident (and a guest looking around) can see.
//
// Private tables (`staging:private` — staging copies them schema-only):
// `profiles` (a person's pickup area), `item_requests` (one-to-one messages
// between two neighbors) and `item_reports` (who reported what, and why).
// Every private→public foreign key is fine (item_requests→items,
// item_reports→items); no public table points at a private one.
//
// The tables of the earlier waste-bank product (members, deposits,
// deposit_items, redemptions, point_transactions, waste_types, rewards,
// collection_schedule) are still created so an existing deployment's history
// is never destroyed, but no route reads or writes them any more, and
// seeder or user-deletion code treats them as legacy.
async function migrate() {
  await pool.query(`DROP TABLE IF EXISTS presses`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      user_id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      pickup_area TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      owner_username TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      item_condition TEXT NOT NULL,
      category TEXT NOT NULL,
      pickup_area TEXT NOT NULL,
      listing_type TEXT NOT NULL,
      price INTEGER,
      status TEXT NOT NULL DEFAULT 'available',
      reserved_for INTEGER,
      reserved_username TEXT,
      weight_g INTEGER NOT NULL DEFAULT 0,
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
      position INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS item_requests (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      requester_id INTEGER NOT NULL,
      requester_username TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS item_reports (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      reporter_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (item_id, reporter_id)
    )
  `);
  for (const t of ['profiles', 'item_requests', 'item_reports']) {
    await pool.query(`COMMENT ON TABLE ${t} IS 'staging:private'`);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS items_feed ON items (created_at DESC) WHERE hidden = FALSE`);
  await pool.query(`CREATE INDEX IF NOT EXISTS items_owner ON items (owner_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS item_photos_item ON item_photos (item_id, position)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS item_requests_open ON item_requests (item_id, requester_id) WHERE status = 'pending'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS item_requests_item ON item_requests (item_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS item_requests_requester ON item_requests (requester_id, created_at DESC)`);

  // Legacy (the earlier waste-bank product). Kept, not used.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS waste_types (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      points_per_kg INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
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
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS leaderboard_opt_out BOOLEAN`);
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
  for (const t of ['members', 'deposits', 'deposit_items', 'redemptions', 'point_transactions']) {
    await pool.query(`COMMENT ON TABLE ${t} IS 'staging:private'`);
  }
}

// ── Staging seed data ───────────────────────────────────────────────────────
//
// Runs on every staging boot, idempotent, obviously fake ("Staging demo …"),
// fixed high ids so real rows can never collide. The people are fake platform
// identities (staging-demo-*), never whoever opened the preview, and none of
// them is the viewing account. Photos are small inline SVG illustrations:
// staging has no platform file storage, so a real upload URL would 404.
const DEMO_GLYPHS = {
  clothes: 'M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z',
  electronics: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z M11 18h2',
  furniture: 'M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3 M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v2H7v-2a2 2 0 0 0-4 0Z M5 18v2 M19 18v2',
  books: 'M12 7v14 M3 18a1 1 0 0 1-1-1V4a2 2 0 0 1 2-2h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
  kitchen: 'M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2 M7 2v20 M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7',
};
const DEMO_COLOURS = {
  clothes: ['#be123c', '#881337'],
  electronics: ['#1d4ed8', '#1e3a8a'],
  furniture: ['#b45309', '#78350f'],
  books: ['#7e22ce', '#581c87'],
  kitchen: ['#0f766e', '#134e4a'],
};
function demoPhoto(category) {
  const [a, b] = DEMO_COLOURS[category] || ['#334155', '#0f172a'];
  const paths = DEMO_GLYPHS[category] || DEMO_GLYPHS.books;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="' + a + '"/><stop offset="1" stop-color="' + b + '"/>' +
    '</linearGradient></defs>' +
    '<rect width="400" height="400" fill="url(#g)"/>' +
    // One path element holding every subpath of the glyph: split into
    // several elements, the ones after the first would lose the stroke
    // attributes and render as filled blobs.
    '<path d="' + paths + '" fill="none" stroke="#ffffff" ' +
    'stroke-opacity="0.5" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
    'transform="translate(80 80) scale(10)"/></svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

async function seedStaging() {
  // Fake people of the neighborhood, each with a pickup area of their own.
  const people = [
    [9000001, 'staging-demo-ani', 'rt02'],
    [9000002, 'staging-demo-budi', 'rt04'],
    [9000003, 'staging-demo-citra', 'rt01'],
  ];
  for (const [id, username, area] of people) {
    await pool.query(
      `INSERT INTO profiles (user_id, username, pickup_area) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING`, [id, username, area]);
  }

  // [id, owner, title, description, condition, category, area, type, price,
  //  status, reserved_for, days_ago, days_ago_done]
  const items = [
    [9000101, 9000001, 'Staging demo: Denim jacket',
      'Size M, washed and ready to wear. Too small for me now.',
      'good', 'clothes', 'rt02', 'free', null, 'available', null, 3, null],
    [9000102, 9000002, 'Staging demo: Desk lamp',
      'Warm white bulb included. Would swap for a standing fan.',
      'like_new', 'electronics', 'rt04', 'swap', null, 'available', null, 5, null],
    [9000103, 9000003, 'Staging demo: Wooden bookshelf',
      'Three shelves, solid wood. Bring a friend to carry it.',
      'good', 'furniture', 'rt01', 'free', null, 'available', null, 1, null],
    [9000104, 9000001, 'Staging demo: Stack of novels',
      'Eight paperbacks, good holiday reading. Happy to swap for cookbooks.',
      'good', 'books', 'rt02', 'swap', null, 'available', null, 7, null],
    [9000105, 9000002, 'Staging demo: Rice cooker',
      'Works well, one small scratch on the lid. Still has its inner pot.',
      'good', 'kitchen', 'rt04', 'cheap', 75000, 'available', null, 2, null],
    [9000106, 9000001, 'Staging demo: Phone charger and cable',
      'Spare USB-C charger, 20 W. Cable is a little short.',
      'like_new', 'electronics', 'rt02', 'free', null, 'available', null, 4, null],
    [9000107, 9000003, 'Staging demo: Cotton shirts, size M',
      'Three plain shirts, worn but no stains. Good for gardening.',
      'worn', 'clothes', 'rt01', 'cheap', 25000, 'available', null, 6, null],
    [9000108, 9000001, "Staging demo: Children's picture books",
      'Six picture books for ages 3 to 6. All pages intact.',
      'good', 'books', 'rt02', 'free', null, 'reserved', 9000002, 8, null],
    [9000109, 9000002, 'Staging demo: Ceramic bowls, set of 4',
      'Four matching bowls, no chips. Handed over last week.',
      'like_new', 'kitchen', 'rt04', 'swap', null, 'done', 9000001, 12, 5],
    [9000110, 9000003, 'Staging demo: Foldable study chair',
      'Folds flat, good for a small room.',
      'good', 'furniture', 'rt01', 'free', null, 'reserved', 9000001, 2, null],
  ];
  for (const [id, owner, title, description, condition, category, area, type,
    price, status, reservedFor, daysAgo, doneAgo] of items) {
    const ins = await pool.query(`
      INSERT INTO items (id, owner_id, owner_username, title, description,
        item_condition, category, pickup_area, listing_type, price, status,
        reserved_for, reserved_username, weight_g, done_at, created_at)
      VALUES ($1, $2, (SELECT username FROM profiles WHERE user_id = $2), $3, $4,
        $5, $6, $7, $8, $9, $10, $11,
        (SELECT username FROM profiles WHERE user_id = $11), $12,
        CASE WHEN $13::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $13::int) END,
        NOW() - make_interval(days => $14::int))
      ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, owner, title, description, condition, category, area, type, price,
        status, reservedFor, CATEGORY_WEIGHT_G[category], doneAgo, daysAgo]);
    if (!ins.rows.length) continue;
    await pool.query(
      `INSERT INTO item_photos (item_id, url, position) VALUES ($1, $2, 0)`,
      [id, demoPhoto(category)]);
  }

  // [id, item, requester, message, status, days_ago]
  const requests = [
    [9000201, 9000108, 9000002, 'Could I pick these up on Saturday morning?', 'accepted', 7],
    [9000202, 9000110, 9000001, 'Is this still around? I can collect tonight.', 'pending', 1],
    [9000203, 9000109, 9000001, 'My kids would love these. Thank you!', 'completed', 11],
  ];
  for (const [id, itemId, requester, message, status, daysAgo] of requests) {
    await pool.query(`
      INSERT INTO item_requests (id, item_id, requester_id, requester_username,
        message, status, resolved_at, created_at)
      VALUES ($1, $2, $3, (SELECT username FROM profiles WHERE user_id = $3), $4, $5,
        CASE WHEN $5 = 'pending' THEN NULL ELSE NOW() - make_interval(days => $6::int) END,
        NOW() - make_interval(days => $6::int))
      ON CONFLICT (id) DO NOTHING`,
      [id, itemId, requester, message, status, daysAgo]);
  }

  // Explicit ids bypass the sequences; push each sequence past the highest
  // seeded id so real inserts can never collide with demo rows.
  for (const t of ['items', 'item_photos', 'item_requests', 'item_reports']) {
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

function getProfile(userId) {
  return pool.query(
    `SELECT user_id, username, pickup_area FROM profiles WHERE user_id = $1`,
    [userId]
  ).then(r => r.rows[0] || null);
}

// Every authenticated /api request lazily provisions the caller's profile
// row. Production-shaped: nothing seeds real visitors.
app.use('/api', (req, res, next) => {
  if (!req.user) return next();
  pool.query(
    `INSERT INTO profiles (user_id, username) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username`,
    [req.user.id, req.user.username]
  ).then(() => next(), next);
});

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

// One of a fixed set of ids, or an error naming the field.
function cleanChoice(v, allowed, field) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!allowed.has(s)) throw new ApiError(400, 'invalid_' + field);
  return s;
}

// Metres along the neighborhood street between two pickup areas, or null
// when either side has no area set.
function distanceBetween(a, b) {
  const i = ZONE_IDS.indexOf(a);
  const j = ZONE_IDS.indexOf(b);
  if (i < 0 || j < 0) return null;
  return Math.abs(i - j) * ZONE_SPACING_M;
}

// The JSON shape of one item, seen by `viewer` (a token's claims or null).
function itemJson(row, viewer, viewerArea) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    condition: row.item_condition,
    category: row.category,
    pickup_area: row.pickup_area,
    listing_type: row.listing_type,
    price: row.price,
    status: row.status,
    owner_username: row.owner_username,
    reserved_username: row.status === 'reserved' ? row.reserved_username : null,
    photo_url: row.photo_url || null,
    is_mine: !!(viewer && row.owner_id === viewer.id),
    hidden: row.hidden === true,
    distance_m: distanceBetween(viewerArea, row.pickup_area),
    created_at: row.created_at,
  };
}

// ── Me / options ────────────────────────────────────────────────────────────

app.get('/api/me', async (req, res, next) => {
  try {
    const options = {
      zones: ZONES,
      categories: CATEGORIES,
      conditions: CONDITIONS,
      listing_types: LISTING_TYPES,
    };
    if (!req.user) return res.json({ guest: true, profile: null, options });
    const p = await getProfile(req.user.id);
    res.json({
      guest: false,
      profile: { username: p ? p.username : req.user.username, pickup_area: p ? p.pickup_area : null },
      options,
    });
  } catch (err) { next(err); }
});

app.patch('/api/me', async (req, res, next) => {
  try {
    let area = null;
    if ('pickup_area' in req.body && req.body.pickup_area !== null && req.body.pickup_area !== '') {
      area = cleanChoice(req.body.pickup_area, new Set(ZONE_IDS), 'pickup_area');
    }
    await pool.query(`UPDATE profiles SET pickup_area = $2 WHERE user_id = $1`, [req.user.id, area]);
    const p = await getProfile(req.user.id);
    res.json({ profile: { username: p.username, pickup_area: p.pickup_area } });
  } catch (err) { next(err); }
});

// ── The feed ────────────────────────────────────────────────────────────────

// Everything still looking for a home, newest first. `category` and `type`
// narrow it; the viewing person's pickup area turns into a walk distance.
app.get('/api/items', async (req, res, next) => {
  try {
    const where = ['i.hidden = FALSE', `i.status <> 'done'`];
    const params = [];
    if (req.query.category && req.query.category !== 'all') {
      const category = cleanChoice(req.query.category, CATEGORY_IDS, 'category');
      params.push(category);
      where.push(`i.category = $${params.length}`);
    }
    if (req.query.type && req.query.type !== 'all') {
      const type = cleanChoice(req.query.type, LISTING_TYPE_IDS, 'type');
      params.push(type);
      where.push(`i.listing_type = $${params.length}`);
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 100);
    params.push(limit);
    const { rows } = await pool.query(`
      SELECT i.*, (SELECT p.url FROM item_photos p
                   WHERE p.item_id = i.id ORDER BY p.position, p.id LIMIT 1) AS photo_url
      FROM items i
      WHERE ${where.join(' AND ')}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT $${params.length}
    `, params);
    const profile = req.user ? await getProfile(req.user.id) : null;
    res.json({ items: rows.map(r => itemJson(r, req.user, profile && profile.pickup_area)) });
  } catch (err) { next(err); }
});

app.get('/api/items/:id', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    const { rows } = await pool.query(`
      SELECT i.*, (SELECT p.url FROM item_photos p
                   WHERE p.item_id = i.id ORDER BY p.position, p.id LIMIT 1) AS photo_url
      FROM items i WHERE i.id = $1`, [id]);
    const row = rows[0];
    if (!row) throw new ApiError(404, 'item_not_found');
    const isOwner = !!(req.user && row.owner_id === req.user.id);
    if (row.hidden && !isOwner) throw new ApiError(404, 'item_not_found');
    const profile = req.user ? await getProfile(req.user.id) : null;
    const item = itemJson(row, req.user, profile && profile.pickup_area);
    item.photos = (await pool.query(
      `SELECT url FROM item_photos WHERE item_id = $1 ORDER BY position, id`, [id]
    )).rows.map(r => r.url);
    if (isOwner) {
      item.requests = (await pool.query(`
        SELECT id, requester_username, message, status, created_at
        FROM item_requests WHERE item_id = $1 ORDER BY created_at DESC, id DESC`, [id])).rows;
    } else if (req.user) {
      const mine = await pool.query(`
        SELECT id, message, status, created_at FROM item_requests
        WHERE item_id = $1 AND requester_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [id, req.user.id]);
      item.my_request = mine.rows[0] || null;
    }
    res.json({ item });
  } catch (err) { next(err); }
});

// Post an item. `photos` are URLs the platform's file storage returned
// (usernode.uploadFile in the page) — never image bytes, never a data URL
// from a person's browser.
app.post('/api/items', async (req, res, next) => {
  try {
    const title = cleanText(req.body.title, 120);
    if (!title) throw new ApiError(400, 'title_required');
    const description = cleanText(req.body.description, 600);
    const condition = cleanChoice(req.body.condition, CONDITION_IDS, 'condition');
    const category = cleanChoice(req.body.category, CATEGORY_IDS, 'category');
    const pickupArea = cleanChoice(req.body.pickup_area, new Set(ZONE_IDS), 'pickup_area');
    const listingType = cleanChoice(req.body.listing_type, LISTING_TYPE_IDS, 'listing_type');
    let price = null;
    if (listingType === 'cheap') {
      price = cleanInt(req.body.price, 1, 100000000);
      if (price === null) throw new ApiError(400, 'invalid_price');
    }
    const raw = Array.isArray(req.body.photos) ? req.body.photos.slice(0, 3) : [];
    const photos = [];
    for (const u of raw) {
      if (typeof u !== 'string' || u.length > 1000 || !/^https:\/\//.test(u)) {
        throw new ApiError(400, 'invalid_photo');
      }
      photos.push(u);
    }
    const id = await withTx(async (client) => {
      const ins = await client.query(`
        INSERT INTO items (owner_id, owner_username, title, description,
          item_condition, category, pickup_area, listing_type, price, weight_g, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id`,
        [req.user.id, req.user.username, title, description, condition, category,
          pickupArea, listingType, price, CATEGORY_WEIGHT_G[category], req.now]);
      const itemId = ins.rows[0].id;
      for (let i = 0; i < photos.length; i++) {
        await client.query(
          `INSERT INTO item_photos (item_id, url, position) VALUES ($1, $2, $3)`,
          [itemId, photos[i], i]);
      }
      return itemId;
    });
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

// Mark an item done: it left the house, whether a neighbor here took it or
// not. A reserved item's accepted request completes with it.
app.post('/api/items/:id/complete', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    await withTx(async (client) => {
      const it = (await client.query(`SELECT * FROM items WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!it) throw new ApiError(404, 'item_not_found');
      if (it.owner_id !== req.user.id) throw new ApiError(403, 'not_your_item');
      if (it.status === 'done') throw new ApiError(409, 'already_done');
      await client.query(
        `UPDATE items SET status = 'done', done_at = $2 WHERE id = $1`, [id, req.now]);
      await client.query(
        `UPDATE item_requests SET status = 'completed', resolved_at = $2
         WHERE item_id = $1 AND status = 'accepted'`, [id, req.now]);
      // The item is gone; nobody else can still be waiting for it.
      await client.query(
        `UPDATE item_requests SET status = 'declined', resolved_at = $2
         WHERE item_id = $1 AND status = 'pending'`, [id, req.now]);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Give a reserved item back to the neighborhood.
app.post('/api/items/:id/release', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    await withTx(async (client) => {
      const it = (await client.query(`SELECT * FROM items WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!it) throw new ApiError(404, 'item_not_found');
      if (it.owner_id !== req.user.id) throw new ApiError(403, 'not_your_item');
      if (it.status !== 'reserved') throw new ApiError(409, 'not_reserved');
      await client.query(
        `UPDATE items SET status = 'available', reserved_for = NULL, reserved_username = NULL
         WHERE id = $1`, [id]);
      await client.query(
        `UPDATE item_requests SET status = 'cancelled', resolved_at = $2
         WHERE item_id = $1 AND status = 'accepted'`, [id, req.now]);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Ask for an item, with a short message to its owner.
app.post('/api/items/:id/requests', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    const message = cleanText(req.body.message, 300);
    if (!message) throw new ApiError(400, 'message_required');
    await withTx(async (client) => {
      const it = (await client.query(`SELECT * FROM items WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!it || it.hidden) throw new ApiError(404, 'item_not_found');
      if (it.owner_id === req.user.id) throw new ApiError(409, 'own_item');
      if (it.status !== 'available') throw new ApiError(409, 'item_unavailable');
      const open = await client.query(
        `SELECT 1 FROM item_requests WHERE item_id = $1 AND requester_id = $2 AND status = 'pending'`,
        [id, req.user.id]);
      if (open.rows.length) throw new ApiError(409, 'already_requested');
      await client.query(`
        INSERT INTO item_requests (item_id, requester_id, requester_username, message, created_at)
        VALUES ($1, $2, $3, $4, $5)`,
        [id, req.user.id, req.user.username, message, req.now]);
    });
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// ── Requests (the owner's and the asker's side) ────────────────────────────

async function loadRequestForOwner(client, id, userId) {
  const r = (await client.query(
    `SELECT * FROM item_requests WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!r) throw new ApiError(404, 'request_not_found');
  const it = (await client.query(
    `SELECT * FROM items WHERE id = $1 FOR UPDATE`, [r.item_id])).rows[0];
  if (!it || it.owner_id !== userId) throw new ApiError(403, 'not_your_item');
  return { request: r, item: it };
}

// Accept: this item is reserved for that person; everyone else waiting is
// declined in the same breath.
app.post('/api/requests/:id/accept', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    await withTx(async (client) => {
      const { request, item } = await loadRequestForOwner(client, id, req.user.id);
      if (request.status !== 'pending') throw new ApiError(409, 'already_resolved');
      if (item.status !== 'available') throw new ApiError(409, 'item_unavailable');
      await client.query(
        `UPDATE item_requests SET status = 'accepted', resolved_at = $2 WHERE id = $1`,
        [id, req.now]);
      await client.query(
        `UPDATE item_requests SET status = 'declined', resolved_at = $2
         WHERE item_id = $1 AND status = 'pending' AND id <> $3`,
        [request.item_id, req.now, id]);
      await client.query(
        `UPDATE items SET status = 'reserved', reserved_for = $2, reserved_username = $3
         WHERE id = $1`, [request.item_id, request.requester_id, request.requester_username]);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/requests/:id/decline', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    await withTx(async (client) => {
      const { request } = await loadRequestForOwner(client, id, req.user.id);
      if (request.status !== 'pending') throw new ApiError(409, 'already_resolved');
      await client.query(
        `UPDATE item_requests SET status = 'declined', resolved_at = $2 WHERE id = $1`,
        [id, req.now]);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/requests/:id/cancel', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    await withTx(async (client) => {
      const r = (await client.query(
        `SELECT * FROM item_requests WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!r) throw new ApiError(404, 'request_not_found');
      if (r.requester_id !== req.user.id) throw new ApiError(403, 'not_your_request');
      if (r.status !== 'pending') throw new ApiError(409, 'already_resolved');
      await client.query(
        `UPDATE item_requests SET status = 'cancelled', resolved_at = $2 WHERE id = $1`,
        [id, req.now]);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Report a post ───────────────────────────────────────────────────────────
//
// A post the neighborhood flags three times is hidden everywhere except to
// its owner, until somebody on the platform's side looks at it.
app.post('/api/items/:id/report', async (req, res, next) => {
  try {
    const id = intParam(req, 'id');
    const reason = cleanChoice(req.body.reason, REPORT_REASONS, 'reason');
    const note = cleanText(req.body.note, 200);
    const hidden = await withTx(async (client) => {
      const it = (await client.query(`SELECT * FROM items WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!it) throw new ApiError(404, 'item_not_found');
      if (it.owner_id === req.user.id) throw new ApiError(403, 'own_item');
      await client.query(`
        INSERT INTO item_reports (item_id, reporter_id, reason, note, created_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (item_id, reporter_id) DO NOTHING`,
        [id, req.user.id, reason, note, req.now]);
      const n = (await client.query(
        `SELECT COUNT(*)::int AS n FROM item_reports WHERE item_id = $1`, [id])).rows[0].n;
      if (n >= REPORT_HIDE_AT) {
        await client.query(`UPDATE items SET hidden = TRUE WHERE id = $1`, [id]);
        return true;
      }
      return false;
    });
    res.status(201).json({ ok: true, hidden });
  } catch (err) { next(err); }
});

// ── My Loops ────────────────────────────────────────────────────────────────

app.get('/api/my/items', async (req, res, next) => {
  try {
    // The auth middleware lets guests through on GET; this list is someone's
    // own, so it needs an account.
    if (!req.user) throw new ApiError(401, 'account_required');
    const { rows } = await pool.query(`
      SELECT i.*, (SELECT p.url FROM item_photos p
                   WHERE p.item_id = i.id ORDER BY p.position, p.id LIMIT 1) AS photo_url,
             (SELECT COUNT(*)::int FROM item_requests r
              WHERE r.item_id = i.id AND r.status = 'pending') AS pending_requests
      FROM items i
      WHERE i.owner_id = $1
      ORDER BY CASE WHEN i.status = 'done' THEN 1 ELSE 0 END,
               i.created_at DESC, i.id DESC
    `, [req.user.id]);
    const profile = await getProfile(req.user.id);
    res.json({
      items: rows.map(r => Object.assign(itemJson(r, req.user, profile && profile.pickup_area), {
        pending_requests: r.pending_requests,
      })),
    });
  } catch (err) { next(err); }
});

app.get('/api/my/requests', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'account_required');
    const { rows } = await pool.query(`
      SELECT r.id AS request_id, r.message, r.status AS request_status,
             r.created_at AS requested_at,
             i.id AS item_id, i.title, i.status AS item_status, i.pickup_area,
             i.owner_username, i.listing_type, i.category, i.price,
             (SELECT p.url FROM item_photos p
              WHERE p.item_id = i.id ORDER BY p.position, p.id LIMIT 1) AS photo_url
      FROM item_requests r
      JOIN items i ON i.id = r.item_id
      WHERE r.requester_id = $1 AND i.hidden = FALSE
      ORDER BY r.created_at DESC, r.id DESC
    `, [req.user.id]);
    res.json({
      requests: rows.map(r => ({
        id: r.request_id,
        message: r.message,
        status: r.request_status,
        requested_at: r.requested_at,
        item: {
          id: r.item_id,
          title: r.title,
          status: r.item_status,
          pickup_area: r.pickup_area,
          owner_username: r.owner_username,
          listing_type: r.listing_type,
          category: r.category,
          price: r.price,
          photo_url: r.photo_url,
        },
      })),
    });
  } catch (err) { next(err); }
});

// ── Impact ──────────────────────────────────────────────────────────────────
//
// A completed loop is an item marked done that this person posted or
// received. The kilograms are the category estimate of each such item.
app.get('/api/impact', async (req, res, next) => {
  try {
    if (!req.user) throw new ApiError(401, 'account_required');
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS loops, COALESCE(SUM(weight_g), 0)::bigint AS weight_g
      FROM items
      WHERE status = 'done' AND (owner_id = $1 OR reserved_for = $1)
    `, [req.user.id]);
    res.json({
      impact: {
        loops: rows[0].loops,
        weight_g: parseInt(rows[0].weight_g, 10),
      },
    });
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
