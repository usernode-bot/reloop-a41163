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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// The five waste types a deposit can be. Stored lowercase; the screen
// capitalises them for display.
const WASTE_TYPES = ['plastic', 'paper', 'metal', 'glass', 'other'];

// Households, newest first, with a member count so neighbours can tell two
// same-named households apart. Guests may read this: the join list on the
// start card is how someone finds their household before they have one.
app.get('/api/households', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT h.id, h.name, COUNT(m.id)::int AS member_count
      FROM households h
      LEFT JOIN members m ON m.household_id = h.id
      GROUP BY h.id, h.name
      ORDER BY h.created_at DESC, h.id DESC
    `);
    res.json({ households: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run fn inside a transaction, rolling back if it throws.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Create a household. The creator becomes its first member in the same
// transaction, so a household can never exist without a member. Duplicate
// names are allowed: the id, not the name, is the key.
app.post('/api/households', async (req, res) => {
  const name = typeof (req.body && req.body.name) === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 120) {
    return res.status(400).json({ error: 'Household name must be 1 to 120 characters.' });
  }
  try {
    const id = await withTx(async (client) => {
      const mine = await client.query('SELECT 1 FROM members WHERE user_id = $1', [req.user.id]);
      if (mine.rowCount) {
        throw Object.assign(new Error('You are already in a household.'), { status: 400 });
      }
      const hh = await client.query(
        `INSERT INTO households (name, created_by, created_by_name)
         VALUES ($1, $2, $3) RETURNING id`,
        [name, req.user.id, req.user.username]
      );
      await client.query(
        `INSERT INTO members (household_id, user_id, username) VALUES ($1, $2, $3)`,
        [hh.rows[0].id, req.user.id, req.user.username]
      );
      return hh.rows[0].id;
    });
    res.status(201).json({ id, name });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Join an existing household. Everyone belongs to exactly one household;
// members.user_id's UNIQUE constraint backs that up.
app.post('/api/households/:id/join', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Household not found.' });
  try {
    const hh = await pool.query('SELECT id FROM households WHERE id = $1', [id]);
    if (!hh.rowCount) return res.status(404).json({ error: 'Household not found.' });
    const mine = await pool.query('SELECT 1 FROM members WHERE user_id = $1', [req.user.id]);
    if (mine.rowCount) return res.status(400).json({ error: 'You are already in a household.' });
    const inserted = await pool.query(
      `INSERT INTO members (household_id, user_id, username)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING RETURNING id`,
      [id, req.user.id, req.user.username]
    );
    if (!inserted.rowCount) return res.status(400).json({ error: 'You are already in a household.' });
    res.status(201).json({ ok: true, household_id: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The signed-in user's household, its members and their balances in one
// payload. Guests and people without a household get `{ household: null }`.
app.get('/api/my-household', async (req, res) => {
  if (!req.user) return res.json({ household: null });
  try {
    const mine = await pool.query(
      'SELECT household_id FROM members WHERE user_id = $1',
      [req.user.id]
    );
    if (!mine.rowCount) return res.json({ household: null });
    const householdId = mine.rows[0].household_id;
    const hh = await pool.query('SELECT id, name FROM households WHERE id = $1', [householdId]);
    if (!hh.rowCount) return res.json({ household: null });
    // One row per member with their totals: 0 when they have no deposits
    // yet. Points first, so the screen can show them highest first.
    const { rows } = await pool.query(`
      SELECT m.id, m.user_id, m.username,
             COALESCE(SUM(d.points), 0)::int AS points,
             COALESCE(SUM(d.weight_grams), 0)::int AS grams
      FROM members m
      LEFT JOIN deposits d ON d.member_id = m.id
      WHERE m.household_id = $1
      GROUP BY m.id, m.user_id, m.username
      ORDER BY points DESC, m.username
    `, [householdId]);
    res.json({ household: hh.rows[0], members: rows, my_user_id: req.user.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record a deposit: who brought the waste, what kind, how heavy. Deposits
// are append-only; there is no edit or delete anywhere.
app.post('/api/deposits', async (req, res) => {
  const body = req.body || {};
  const wasteType = typeof body.waste_type === 'string' ? body.waste_type.trim().toLowerCase() : '';
  const weightKg = Number(body.weight_kg);
  const memberId = Number(body.member_id);

  if (!WASTE_TYPES.includes(wasteType)) {
    return res.status(400).json({ error: 'Waste type must be Plastic, Paper, Metal, Glass or Other.' });
  }
  if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 500) {
    return res.status(400).json({ error: 'Weight must be more than 0 and at most 500 kg.' });
  }
  if (!Number.isInteger(memberId)) {
    return res.status(400).json({ error: 'Pick a member of your household.' });
  }
  // Weights live in the database as whole grams, never floats; points are 1
  // per full kilogram and fractions do not carry over between deposits.
  const weightGrams = Math.round(weightKg * 1000);
  const points = Math.floor(weightGrams / 1000);
  try {
    // The member must exist and share a household with the caller; anything
    // else is a 400 and writes nothing.
    const member = await pool.query(
      `SELECT m.id, m.household_id
       FROM members m
       JOIN members me ON me.household_id = m.household_id AND me.user_id = $2
       WHERE m.id = $1`,
      [memberId, req.user.id]
    );
    if (!member.rowCount) {
      return res.status(400).json({ error: 'That member is not in your household.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO deposits
         (household_id, member_id, waste_type, weight_grams, points, recorded_by, recorded_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, household_id, member_id, waste_type, weight_grams, points,
                 recorded_by, recorded_by_name, created_at`,
      [member.rows[0].household_id, memberId, wasteType, weightGrams, points,
       req.user.id, req.user.username]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Staging seed ("Staging mock data" in the platform conventions): two
// obviously fake households with fake members and deposits, so the screen
// can be seen populated. Only fake identities, never a real user; inserted
// only while the households table is empty, so it runs once per database
// and is never a signal app logic reads. Production starts empty.
async function seedStaging() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM households');
  if (rows[0].n > 0) return;
  const hh = await pool.query(
    `INSERT INTO households (name, created_by, created_by_name) VALUES
       ('Staging demo: RT 04 Anggrek', -1, 'Demo Bu Sari'),
       ('Staging demo: RW 07 Mawar', -2, 'Demo Pak Budi')
     RETURNING id, name`
  );
  const ids = Object.fromEntries(hh.rows.map((r) => [r.name, r.id]));
  const anggrek = ids['Staging demo: RT 04 Anggrek'];
  const mawar = ids['Staging demo: RW 07 Mawar'];
  await pool.query(
    `INSERT INTO members (household_id, user_id, username) VALUES
       ($1, -1, 'Demo Bu Sari'),
       ($1, -3, 'Demo Pak Darsi'),
       ($1, -4, 'Demo Mita'),
       ($2, -2, 'Demo Pak Budi'),
       ($2, -5, 'Demo Yuni')
     ON CONFLICT (user_id) DO NOTHING`,
    [anggrek, mawar]
  );
  const { rows: demoMembers } = await pool.query(
    'SELECT id, user_id, username, household_id FROM members WHERE user_id < 0'
  );
  const byUser = Object.fromEntries(demoMembers.map((m) => [m.user_id, m]));
  // [member user_id, waste_type, weight in grams]
  const demoDeposits = [
    [-1, 'plastic', 3400],
    [-3, 'paper', 5200],
    [-4, 'metal', 1800],
    [-1, 'glass', 2100],
    [-4, 'other', 900],
    [-2, 'plastic', 6000],
    [-5, 'paper', 4500],
    [-2, 'metal', 2200],
    [-5, 'glass', 1100],
  ];
  for (const [userId, wasteType, weightGrams] of demoDeposits) {
    const member = byUser[userId];
    if (!member) continue;
    await pool.query(
      `INSERT INTO deposits
         (household_id, member_id, waste_type, weight_grams, points, recorded_by, recorded_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [member.household_id, member.id, wasteType, weightGrams,
       Math.floor(weightGrams / 1000), userId, member.username]
    );
  }
}

async function start() {
  // All three tables are append-only: there is no UPDATE or DELETE anywhere
  // in this app. Every deposit a household makes is permanent.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS households (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      created_by INTEGER NOT NULL,
      created_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES households(id),
      user_id INTEGER NOT NULL UNIQUE,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposits (
      id SERIAL PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES households(id),
      member_id INTEGER NOT NULL REFERENCES members(id),
      waste_type VARCHAR(16) NOT NULL,
      weight_grams INTEGER NOT NULL,
      points INTEGER NOT NULL,
      recorded_by INTEGER NOT NULL,
      recorded_by_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  if (IS_STAGING) await seedStaging();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
