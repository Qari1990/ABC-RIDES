// In-app notifications. The app polls /api/notifications/unread-count, so a
// row here is all it takes to alert someone.
// Users who turned on push notifications also get it on their phone/computer.
function notify(db, userId, title, body = null, link = null) {
  db.prepare('INSERT INTO notifications (user_id, title, body, link) VALUES (?, ?, ?, ?)').run(userId, title, body, link);
  try {
    require('./push').sendPush(db, userId, { title, body, link });
  } catch (err) {
    console.warn(`Push skipped: ${err.message}`);
  }
}

const route = (r) => `${r.from_city} → ${r.to_city}`;
const when = (iso) => new Date(iso).toLocaleString('en-PK', {
  timeZone: process.env.TZ_DISPLAY || 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});

module.exports = { notify, route, when };
