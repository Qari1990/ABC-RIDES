const { openDb } = require('./db');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const app = createApp(openDb());

app.listen(port, () => {
  console.log(`ABC Rides running at http://localhost:${port}`);
});
