const { openDb } = require('./db');
const { createApp } = require('./app');
const { adminEmails } = require('./routes/users');

const port = Number(process.env.PORT) || 3000;
const db = openDb();

// Promote accounts listed in ADMIN_EMAILS that registered before the list was set.
for (const email of adminEmails()) {
  db.prepare(`UPDATE users SET role = 'admin' WHERE email = ?`).run(email);
}

const app = createApp(db);
app.listen(port, () => {
  console.log(`ABC Rides running at http://localhost:${port}`);
});
