const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { requireAdmin, hashPassword } = require('../auth');
const { transaction } = require('../db');
const { HttpError, bad, str, int } = require('../errors');
const { notify } = require('../notify');
const { getSettings, setSettings, settingsSpec } = require('../settings');
const { applyTxn } = require('../wallet');
const { smsConfigured } = require('../sms');
const { backupStatus } = require('../backup');

module.exports = function adminRouter(db, { uploadDir }) {
  const router = express.Router();
  router.use(requireAdmin);

  const getUser = (id) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    if (!user) throw new HttpError(404, 'User not found');
    return user;
  };
  const summary = (u) => ({
    id: u.id, name: u.name, email: u.email, phone: u.phone, traveler_type: u.traveler_type, gender: u.gender,
    organization: u.organization, role: u.role, suspended: !!u.suspended, verification_status: u.verification_status,
    verification_doc_type: u.verification_doc_type, created_at: u.created_at,
    phone_verified: !!u.phone_verified, cnic: u.cnic ? `${u.cnic.slice(0, 5)}-${u.cnic.slice(5, 12)}-${u.cnic.slice(12)}` : null,
    student_status: u.student_status, driver_status: u.driver_status, licence_number: u.licence_number,
    reliability: u.reliability, wallet_balance: u.wallet_balance,
  });
  const countBy = (sql) => Object.fromEntries(db.prepare(sql).all().map((r) => [r.k, r.n]));

  // ---- Car changes waiting for approval (see POST /me/vehicle) ----
  router.get('/vehicle-changes', (_req, res) => {
    const rows = db.prepare(`SELECT v.*, u.name, u.phone FROM vehicles v JOIN users u ON u.id = v.user_id
      WHERE v.pending_change IS NOT NULL ORDER BY v.pending_since`).all();
    res.json(rows.map((v) => ({
      user_id: v.user_id, name: v.name, phone: v.phone, since: v.pending_since,
      current: { make: v.make, model: v.model, year: v.year, color: v.color, plate: v.plate, seats: v.seats },
      proposed: JSON.parse(v.pending_change),
      documents: db.prepare(`SELECT id, kind, created_at FROM documents WHERE user_id = ? AND kind IN ('vehicle_photo_new', 'vehicle_registration_new')
        ORDER BY id DESC LIMIT 2`).all(v.user_id),
    })));
  });

  router.post('/vehicle-changes/:userId/:decision', (req, res) => {
    const v = db.prepare('SELECT * FROM vehicles WHERE user_id = ? AND pending_change IS NOT NULL').get(Number(req.params.userId));
    if (!v) throw new HttpError(404, 'No car change waiting for this driver');
    const next = JSON.parse(v.pending_change);
    if (req.params.decision === 'approve') {
      db.prepare(`UPDATE vehicles SET make = ?, model = ?, year = ?, color = ?, plate = ?, seats = ?, body_type = ?, engine_cc = ?,
        car_class = ?, ac = ?, features = ?, pending_change = NULL, pending_since = NULL, change_note = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`)
        .run(next.make, next.model, next.year, next.color, next.plate, next.seats, next.body_type, next.engine_cc,
          next.car_class, next.ac, JSON.stringify(next.features || []), v.user_id);
      notify(db, v.user_id, 'Your new car is approved', `${next.make} ${next.model} (${next.plate}) is now used for your rides.`, '/profile');
    } else if (req.params.decision === 'reject') {
      const note = str((req.body || {}).note, 'Reason', { required: true, max: 300 });
      db.prepare('UPDATE vehicles SET pending_change = NULL, pending_since = NULL, change_note = ? WHERE user_id = ?').run(note, v.user_id);
      notify(db, v.user_id, 'Car change not approved', note, '/profile');
    } else {
      throw bad('Decision must be approve or reject');
    }
    res.status(204).end();
  });

  router.get('/errors', (_req, res) => {
    res.json(db.prepare(`SELECT e.*, u.name AS user_name FROM error_log e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT 50`).all());
  });

  router.delete('/errors', (_req, res) => {
    db.prepare('DELETE FROM error_log').run();
    res.status(204).end();
  });

  router.get('/stats', (_req, res) => {
    res.json({
      users: countBy('SELECT traveler_type k, COUNT(*) n FROM users GROUP BY traveler_type'),
      rides: countBy('SELECT status k, COUNT(*) n FROM rides GROUP BY status'),
      bookings: countBy('SELECT status k, COUNT(*) n FROM bookings GROUP BY status'),
      seats_booked: db.prepare(`SELECT COALESCE(SUM(seats), 0) n FROM bookings WHERE status = 'confirmed'`).get().n,
      open_requests: db.prepare(`SELECT COUNT(*) n FROM ride_requests WHERE status = 'open' AND latest_at > ?`).get(new Date().toISOString()).n,
      pending_verifications: db.prepare(`SELECT COUNT(*) n FROM users WHERE verification_status = 'pending'`).get().n,
      open_reports: db.prepare(`SELECT COUNT(*) n FROM reports WHERE status = 'open'`).get().n,
      pending_topups: db.prepare(`SELECT COUNT(*) n FROM topup_requests WHERE status = 'pending'`).get().n,
      // Money earned: fees charged minus fees refunded.
      revenue: -db.prepare(`SELECT COALESCE(SUM(amount), 0) n FROM wallet_transactions WHERE type IN ('commission', 'fee', 'refund')`).get().n,
      revenue_30d: -db.prepare(`SELECT COALESCE(SUM(amount), 0) n FROM wallet_transactions
        WHERE type IN ('commission', 'fee', 'refund') AND created_at > ?`).get(new Date(Date.now() - 30 * 864e5).toISOString()).n,
      wallet_total: db.prepare('SELECT COALESCE(SUM(wallet_balance), 0) n FROM users').get().n,
      sms_configured: smsConfigured(),
      backup: backupStatus(),
      pending_car_changes: db.prepare('SELECT COUNT(*) n FROM vehicles WHERE pending_change IS NOT NULL').get().n,
      errors_7d: db.prepare(`SELECT COUNT(*) n FROM error_log WHERE created_at > ?`).get(new Date(Date.now() - 7 * 864e5).toISOString()).n,
    });
  });

  router.get('/users', (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    const rows = db.prepare(`SELECT * FROM users WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? ORDER BY id DESC LIMIT 100`).all(q, q, q);
    res.json(rows.map(summary));
  });

  // Everyone with something to review: identity, student card or driver application.
  router.get('/verifications', (_req, res) => {
    const users = db.prepare(`
      SELECT * FROM users WHERE verification_status = 'pending' OR student_status = 'pending' OR driver_status = 'pending'
      ORDER BY id`).all();
    res.json(users.map((u) => ({
      ...summary(u),
      vehicle: db.prepare('SELECT * FROM vehicles WHERE user_id = ?').get(u.id) || null,
      // Latest upload of each kind.
      documents: db.prepare(`
        SELECT id, kind, created_at FROM documents d WHERE user_id = ?
          AND id = (SELECT MAX(id) FROM documents WHERE user_id = d.user_id AND kind = d.kind)
        ORDER BY id`).all(u.id),
    })));
  });

  router.get('/documents/:id', (req, res) => {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
    if (!doc) throw new HttpError(404, 'Document not found');
    res.set('cache-control', 'private, no-store');
    res.sendFile(path.join(uploadDir, path.basename(doc.file)));
  });

  // Approves or rejects everything the user has waiting for review.
  router.post('/users/:id/review', (req, res) => {
    const user = getUser(req.params.id);
    const approve = !!(req.body && req.body.approve);
    const note = str(req.body && req.body.note, 'Note', { max: 300 });
    const done = [];
    transaction(db, () => {
      if (user.verification_status === 'pending') {
        db.prepare('UPDATE users SET verification_status = ?, verification_note = ? WHERE id = ?')
          .run(approve ? 'verified' : 'rejected', note, user.id);
        done.push('identity');
      }
      if (user.student_status === 'pending') {
        db.prepare('UPDATE users SET student_status = ? WHERE id = ?').run(approve ? 'verified' : 'rejected', user.id);
        done.push('student card');
      }
      if (user.driver_status === 'pending') {
        const identityOk = approve && (user.verification_status === 'verified' || done.includes('identity'));
        db.prepare('UPDATE users SET driver_status = ?, driver_note = ? WHERE id = ?')
          .run(identityOk ? 'approved' : 'rejected', note, user.id);
        done.push('driver registration');
      }
      if (!done.length) throw bad('Nothing is waiting for review for this user');
      notify(db, user.id,
        approve ? 'You are verified ✅' : 'Verification not approved',
        approve ? `Approved: ${done.join(', ')}.${done.includes('driver registration') ? ' You can now post rides.' : ''}`
          : `Not approved: ${done.join(', ')}. ${note || 'Please upload clearer photos and try again.'}`,
        '/profile');
    });
    res.json(summary(getUser(user.id)));
  });

  // Credit (positive) or debit (negative) a wallet by hand, e.g. a goodwill credit.
  router.post('/users/:id/wallet', (req, res) => {
    const user = getUser(req.params.id);
    const amount = int(req.body && req.body.amount, 'Amount', { min: -100000, max: 100000 });
    if (!amount) throw bad('Amount cannot be zero');
    const note = str(req.body && req.body.note, 'Reason', { required: true, max: 200 });
    transaction(db, () => {
      applyTxn(db, user.id, amount, 'adjustment', { note });
      notify(db, user.id, amount > 0 ? `Rs ${amount} added to your wallet` : `Rs ${-amount} deducted from your wallet`, note, '/wallet');
    });
    res.json(summary(getUser(user.id)));
  });

  router.post('/users/:id/reliability', (req, res) => {
    const user = getUser(req.params.id);
    const value = int(req.body && req.body.reliability, 'Reliability', { min: 0, max: 100 });
    db.prepare('UPDATE users SET reliability = ? WHERE id = ?').run(value, user.id);
    res.json(summary(getUser(user.id)));
  });

  router.get('/settings', (_req, res) => res.json({ values: getSettings(db), spec: settingsSpec() }));
  router.put('/settings', (req, res) => res.json({ values: setSettings(db, req.body), spec: settingsSpec() }));

  router.get('/topups', (req, res) => {
    const status = ['approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    res.json(db.prepare(`
      SELECT t.*, u.name AS user_name, u.phone AS user_phone FROM topup_requests t JOIN users u ON u.id = t.user_id
      WHERE t.status = ? ORDER BY t.id DESC LIMIT 100`).all(status));
  });

  router.post('/topups/:id/:decision', (req, res) => {
    const { decision } = req.params;
    if (!['approve', 'reject'].includes(decision)) throw new HttpError(404, 'Not found');
    const note = str(req.body && req.body.note, 'Note', { max: 200 });
    transaction(db, () => {
      const t = db.prepare('SELECT * FROM topup_requests WHERE id = ?').get(Number(req.params.id));
      if (!t) throw new HttpError(404, 'Top-up not found');
      if (t.status !== 'pending') throw bad(`This top-up is already ${t.status}`);
      db.prepare('UPDATE topup_requests SET status = ?, note = ?, reviewed_at = ? WHERE id = ?')
        .run(decision === 'approve' ? 'approved' : 'rejected', note, new Date().toISOString(), t.id);
      if (decision === 'approve') {
        applyTxn(db, t.user_id, t.amount, 'topup', { note: `${t.method} ref ${t.reference}` });
        notify(db, t.user_id, `Rs ${t.amount} added to your wallet ✅`, `Top-up ${t.reference} approved`, '/wallet');
      } else {
        notify(db, t.user_id, 'Top-up not approved', `${t.reference}: ${note || 'We could not find this payment.'}`, '/wallet');
      }
    });
    res.json({ ok: true });
  });

  // For users who forgot their password while SMS reset is unavailable: the
  // admin reads the temporary password to them after checking who they are.
  router.post('/users/:id/temp-password', (req, res) => {
    const user = getUser(req.params.id);
    const password = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    res.json({ password });
  });

  router.post('/users/:id/suspend', (req, res) => {
    const user = getUser(req.params.id);
    if (user.role === 'admin') throw bad('Admins cannot be suspended');
    const suspended = !!(req.body && req.body.suspended);
    db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(suspended ? 1 : 0, user.id);
    if (suspended) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    res.json(summary(getUser(user.id)));
  });

  router.get('/reports', (req, res) => {
    const status = req.query.status === 'resolved' ? 'resolved' : 'open';
    res.json(db.prepare(`
      SELECT rp.*, a.name AS reporter_name, b.name AS reported_name, b.suspended AS reported_suspended
      FROM reports rp JOIN users a ON a.id = rp.reporter_id JOIN users b ON b.id = rp.reported_user_id
      WHERE rp.status = ? ORDER BY rp.id DESC LIMIT 100`).all(status));
  });

  router.post('/reports/:id/resolve', (req, res) => {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(req.params.id));
    if (!report) throw new HttpError(404, 'Report not found');
    db.prepare(`UPDATE reports SET status = 'resolved', resolution = ? WHERE id = ?`)
      .run(str(req.body && req.body.resolution, 'Resolution', { max: 300 }), report.id);
    res.json({ ok: true });
  });

  return router;
};
