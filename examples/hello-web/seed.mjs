// Seed script for hello-web: `node seed.mjs <db-path> <preset>`.
// This is the manifest's `create:` command — backlot resolves {{ns}}/{{preset}}
// and invokes it; the sqlite driver's template capability is just a file copy.
import { DatabaseSync } from 'node:sqlite';

const [dbPath = './hello.db', preset = 'dev'] = process.argv.slice(2);

const db = new DatabaseSync(dbPath);
db.exec('DROP TABLE IF EXISTS greetings');
db.exec('CREATE TABLE greetings (id INTEGER PRIMARY KEY, message TEXT NOT NULL)');

const seeds = {
  dev: ['Hello from the dev preset', 'Deterministic data beats drifted data', 'Bind, don’t rebuild'],
  empty: [],
};

const rows = seeds[preset];
if (!rows) {
  console.error(`unknown preset '${preset}' (have: ${Object.keys(seeds).join(', ')})`);
  process.exit(1);
}
const insert = db.prepare('INSERT INTO greetings (message) VALUES (?)');
for (const m of rows) insert.run(m);
console.log(`seeded ${dbPath} with preset '${preset}' (${rows.length} rows)`);
