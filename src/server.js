import 'dotenv/config';
import { createApp } from './app.js';
import { runMigrations } from './db/migrate.js';

runMigrations();

const port = Number(process.env.PORT) || 4000;
createApp().listen(port, () => {
  console.log(`RSK Jewellers API listening on http://localhost:${port}`);
});
