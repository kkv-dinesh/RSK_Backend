import 'dotenv/config';
import { createApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { syncAccessControl } from './db/seed/run.js';

runMigrations();
// New permissions (e.g. the chit.* ones) must reach existing databases too, not only freshly seeded ones.
syncAccessControl();

const port = Number(process.env.PORT) || 4000;
createApp().listen(port, () => {
  console.log(`RSK Jewellers API listening on http://localhost:${port}`);
});
