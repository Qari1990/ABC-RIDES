const express = require('express');
const { mapConfig } = require('../security');
const { fcmConfigured } = require('../fcm');
const { TERMS_VERSION } = require('../terms');
const { requireUser } = require('../auth');
const { HttpError, bad, str, int, oneOf } = require('../errors');
const { notify } = require('../notify');
const { getSettings } = require('../settings');
const { freeConfirmationsLeft } = require('../wallet');

const TOPUP_METHODS = ['jazzcash', 'easypaisa', 'bank_transfer'];
const MAX_PENDING_TOPUPS = 3;

module.exports = function walletRouter(db) {
  const router = express.Router();

  // Fees, booking mode and requirements, so the app can explain them.
  router.get('/settings', (_req, res) => res.json({ ...getSettings(db), map: mapConfig(), app_push: fcmConfigured(), terms_version: TERMS_VERSION }));

  router.get('/me/wallet', requireUser, (req, res) => {
    const settings = getSettings(db);
    const u = req.user;
    res.json({
      balance: u.wallet_balance,
      reliability: u.reliability,
      free_confirmations_left: freeConfirmationsLeft(db, settings, u.id),
      low_reliability: u.reliability < settings.reliability_threshold,
      settings,
      transactions: db.prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(u.id),
      topups: db.prepare('SELECT * FROM topup_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(u.id),
    });
  });

  // The user sends money to one of the platform's accounts, then reports the
  // transaction ID here. An admin checks it arrived and approves the top-up.
  router.post('/me/wallet/topups', requireUser, (req, res) => {
    const b = req.body || {};
    const settings = getSettings(db);
    const amount = int(b.amount, 'Amount', { min: settings.min_topup, max: 100000 });
    const method = oneOf(b.method, 'Payment method', TOPUP_METHODS, { required: true });
    const reference = str(b.reference, 'Transaction ID', { required: true, max: 40 });
    if (!/^[A-Za-z0-9-]{6,40}$/.test(reference)) throw bad('Transaction ID should be 6 or more letters/numbers, as shown in your payment receipt');
    if (db.prepare('SELECT 1 FROM topup_requests WHERE reference = ?').get(reference)) {
      throw new HttpError(409, 'This transaction ID has already been submitted');
    }
    const pending = db.prepare(`SELECT COUNT(*) n FROM topup_requests WHERE user_id = ? AND status = 'pending'`).get(req.user.id).n;
    if (pending >= MAX_PENDING_TOPUPS) throw bad('You already have top-ups waiting for review');
    const { lastInsertRowid } = db.prepare('INSERT INTO topup_requests (user_id, amount, method, reference) VALUES (?, ?, ?, ?)')
      .run(req.user.id, amount, method, reference);
    for (const a of db.prepare(`SELECT id FROM users WHERE role = 'admin'`).all()) {
      notify(db, a.id, 'Wallet top-up to check', `${req.user.name}: Rs ${amount} via ${method}, ref ${reference}`, '/admin?tab=topups');
    }
    res.status(201).json(db.prepare('SELECT * FROM topup_requests WHERE id = ?').get(lastInsertRowid));
  });

  return router;
};
