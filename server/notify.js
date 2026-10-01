// In-app notifications. The app polls /api/notifications/unread-count, so a
// row here is all it takes to alert someone.
function notify(db, userId, title, body = null, link = null) {
  db.prepare('INSERT INTO notifications (user_id, title, body, link) VALUES (?, ?, ?, ?)').run(userId, title, body, link);
}

const route = (r) => `${r.from_city} → ${r.to_city}`;
const when = (iso) => new Date(iso).toLocaleString('en-PK', {
  timeZone: process.env.TZ_DISPLAY || 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});

module.exports = { notify, route, when };
