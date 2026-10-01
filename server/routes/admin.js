const express = require('express');
const path = require('node:path');
const { requireAdmin } = require('../auth');
const { HttpError, bad, str } = require('../errors');
const { notify } = require('../notify');

const DOC_LABEL = { cnic: 'CNIC', student_card: 'student card', employee_card: 'employee card', driving_license: 'driving licence' };

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
  });
  const countBy = (sql) => Object.fromEntries(db.prepare(sql).all().map((r) => [r.k, r.n]));

  router.get('/stats', (_req, res) => {
    res.json({
      users: countBy('SELECT traveler_type k, COUNT(*) n FROM users GROUP BY traveler_type'),
      rides: countBy('SELECT status k, COUNT(*) n FROM rides GROUP BY status'),
      bookings: countBy('SELECT status k, COUNT(*) n FROM bookings GROUP BY status'),
      seats_booked: db.prepare(`SELECT COALESCE(SUM(seats), 0) n FROM bookings WHERE status = 'confirmed'`).get().n,
      open_requests: db.prepare(`SELECT COUNT(*) n FROM ride_requests WHERE status = 'open' AND latest_at > ?`).get(new Date().toISOString()).n,
      pending_verifications: db.prepare(`SELECT COUNT(*) n FROM users WHERE verification_status = 'pending'`).get().n,
      open_reports: db.prepare(`SELECT COUNT(*) n FROM reports WHERE status = 'open'`).get().n,
    });
  });

  router.get('/users', (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    const rows = db.prepare(`SELECT * FROM users WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? ORDER BY id DESC LIMIT 100`).all(q, q, q);
    res.json(rows.map(summary));
  });

  router.get('/verifications', (_req, res) => {
    res.json(db.prepare(`SELECT * FROM users WHERE verification_status = 'pending' ORDER BY id`).all().map(summary));
  });

  router.get('/users/:id/document', (req, res) => {
    const user = getUser(req.params.id);
    if (!user.verification_file) throw new HttpError(404, 'No document uploaded');
    res.set('cache-control', 'private, no-store');
    res.sendFile(path.join(uploadDir, path.basename(user.verification_file)));
  });

  router.post('/users/:id/verification', (req, res) => {
    const user = getUser(req.params.id);
    if (user.verification_status !== 'pending') throw bad('This user has no pending verification');
    const approve = !!(req.body && req.body.approve);
    const note = str(req.body && req.body.note, 'Note', { max: 300 });
    db.prepare('UPDATE users SET verification_status = ?, verification_note = ? WHERE id = ?')
      .run(approve ? 'verified' : 'rejected', note, user.id);
    notify(db, user.id,
      approve ? 'You are verified ✅' : 'Verification not approved',
      approve ? `Your ${DOC_LABEL[user.verification_doc_type]} was approved. Your profile now shows a verified badge.`
        : note || 'Please upload a clearer photo of your document.',
      '/profile');
    res.json(summary(getUser(user.id)));
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
