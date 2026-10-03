// A small error log in the database, so admins can see what went wrong on
// users' phones and on the server without an outside monitoring service.
const KEEP = 500;

function logError(db, { source, message, detail, url, userId, userAgent }) {
  try {
    const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
    db.prepare('INSERT INTO error_log (source, message, detail, url, user_id, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(source, clip(message, 500) || 'Unknown error', clip(detail, 4000), clip(url, 500), userId || null, clip(userAgent, 300));
    db.prepare('DELETE FROM error_log WHERE id <= (SELECT MAX(id) FROM error_log) - ?').run(KEEP);
  } catch (err) {
    console.error('Could not log error:', err.message);
  }
}

module.exports = { logError };
