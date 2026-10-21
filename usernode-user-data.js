'use strict';

// Erasing and exporting one person's rows when they delete their Homeroom
// account.
//
// The platform calls these two server-to-server routes on this app's
// production container. Each request carries a platform token in
// `x-usernode-platform-token` (never a person's sign-in token): RS256,
// signed by the same key as a person's sign-in token, with `pur` naming
// what the call is for and the person's `id` / `usernode_pubkey` as claims.
// There is no body — the person is read from the verified token only.
//
// Mounted from server.js BEFORE the sign-in middleware, because these
// requests carry no person's sign-in token.

const jwt = require('jsonwebtoken');

const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

function readPerson(req) {
  const token = req.headers['x-usernode-platform-token'];
  if (!token || !JWT_PUBLIC_KEY || !APP_AUDIENCE) return null;
  try {
    const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
      algorithms: ['RS256'],
      issuer: 'usernode',
      audience: APP_AUDIENCE,
    });
    if (!claims || !Number.isInteger(claims.id)) return null;
    return claims;
  } catch (_) {
    return null;
  }
}

module.exports = function mountUserData(app, pool) {
  // Erase (or anonymise) everything this person had here. Idempotent: the
  // platform retries until it gets a 2xx, so a second call for the same
  // person finds nothing left and still answers 200.
  app.post('/usernode/user-deletion', async (req, res) => {
    const person = readPerson(req);
    if (!person || person.pur !== 'user-deletion') {
      return res.status(403).json({ error: 'forbidden' });
    }
    const userId = person.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Their listings go, with the photos and the requests hanging off
      // them (item_photos and item_requests cascade with the item).
      await client.query(
        `DELETE FROM item_requests WHERE requester_id = $1 OR item_id IN
           (SELECT id FROM items WHERE owner_id = $1)`, [userId]);
      await client.query(
        `DELETE FROM item_reports WHERE reporter_id = $1 OR item_id IN
           (SELECT id FROM items WHERE owner_id = $1)`, [userId]);
      await client.query(`DELETE FROM item_photos WHERE item_id IN
        (SELECT id FROM items WHERE owner_id = $1)`, [userId]);
      await client.query(`DELETE FROM items WHERE owner_id = $1`, [userId]);
      // An item someone else owns that was being held for this person goes
      // back on the shelf rather than staying reserved for a deleted account.
      await client.query(
        `UPDATE items
         SET status = CASE WHEN status = 'reserved' THEN 'available' ELSE status END,
             reserved_for = NULL, reserved_username = NULL
         WHERE reserved_for = $1`, [userId]);
      await client.query(`DELETE FROM profiles WHERE user_id = $1`, [userId]);

      // Rows from the earlier waste-bank product, if this deployment ever
      // had any: erase the person's deposits, redemptions and ledger, then
      // the member row itself.
      const legacy = await client.query(
        `SELECT id FROM members WHERE user_id = $1`, [userId]);
      for (const row of legacy.rows) {
        await client.query(
          `DELETE FROM point_transactions WHERE member_id = $1`, [row.id]);
        await client.query(
          `DELETE FROM redemptions WHERE member_id = $1`, [row.id]);
        await client.query(
          `DELETE FROM deposit_items WHERE deposit_id IN
             (SELECT id FROM deposits WHERE member_id = $1)`, [row.id]);
        await client.query(`DELETE FROM deposits WHERE member_id = $1`, [row.id]);
        await client.query(`DELETE FROM members WHERE id = $1`, [row.id]);
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('user-deletion failed', err.message);
      res.status(500).json({ error: 'server_error' });
    } finally {
      client.release();
    }
  });

  // A JSON copy of the person's rows, for their export.
  app.get('/usernode/user-export', async (req, res) => {
    const person = readPerson(req);
    if (!person || person.pur !== 'user-export') {
      return res.status(403).json({ error: 'forbidden' });
    }
    const userId = person.id;
    try {
      const tables = {};
      tables.profiles = (await pool.query(
        `SELECT * FROM profiles WHERE user_id = $1`, [userId])).rows;
      tables.items = (await pool.query(
        `SELECT * FROM items WHERE owner_id = $1 ORDER BY id`, [userId])).rows;
      tables.item_photos = (await pool.query(
        `SELECT p.* FROM item_photos p JOIN items i ON i.id = p.item_id
         WHERE i.owner_id = $1 ORDER BY p.id`, [userId])).rows;
      tables.item_requests = (await pool.query(
        `SELECT * FROM item_requests WHERE requester_id = $1 ORDER BY id`, [userId])).rows;
      tables.requests_for_my_items = (await pool.query(
        `SELECT r.* FROM item_requests r JOIN items i ON i.id = r.item_id
         WHERE i.owner_id = $1 ORDER BY r.id`, [userId])).rows;
      tables.item_reports = (await pool.query(
        `SELECT * FROM item_reports WHERE reporter_id = $1 ORDER BY id`, [userId])).rows;

      const legacy = (await pool.query(
        `SELECT id FROM members WHERE user_id = $1`, [userId])).rows[0];
      if (legacy) {
        tables.deposits = (await pool.query(
          `SELECT * FROM deposits WHERE member_id = $1 ORDER BY id`, [legacy.id])).rows;
        tables.deposit_items = (await pool.query(
          `SELECT i.* FROM deposit_items i JOIN deposits d ON d.id = i.deposit_id
           WHERE d.member_id = $1 ORDER BY i.id`, [legacy.id])).rows;
        tables.redemptions = (await pool.query(
          `SELECT * FROM redemptions WHERE member_id = $1 ORDER BY id`, [legacy.id])).rows;
        tables.point_transactions = (await pool.query(
          `SELECT * FROM point_transactions WHERE member_id = $1 ORDER BY id`, [legacy.id])).rows;
      }
      res.json({ userId, tables });
    } catch (err) {
      console.error('user-export failed', err.message);
      res.status(500).json({ error: 'server_error' });
    }
  });
};
