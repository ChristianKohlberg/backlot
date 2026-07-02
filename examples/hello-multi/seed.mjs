// Seed for hello-multi: `node seed.mjs <db-path> <preset>`. Two tables so the
// worker (jobs) and the web/api pair (items) exercise the same datastore.
import { DatabaseSync } from 'node:sqlite';

const [dbPath = './multi.db', preset = 'dev'] = process.argv.slice(2);

const db = new DatabaseSync(dbPath);
db.exec('DROP TABLE IF EXISTS items');
db.exec('DROP TABLE IF EXISTS jobs');
db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
db.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'queued')");

const presets = {
  dev: { items: ['alpha', 'beta', 'gamma'], jobs: 3 },
  demo: { items: ['showpiece'], jobs: 1 },
  empty: { items: [], jobs: 0 },
};

const p = presets[preset];
if (!p) {
  console.error(`unknown preset '${preset}' (have: ${Object.keys(presets).join(', ')})`);
  process.exit(1);
}
const insertItem = db.prepare('INSERT INTO items (name) VALUES (?)');
for (const name of p.items) insertItem.run(name);
const insertJob = db.prepare("INSERT INTO jobs (status) VALUES ('queued')");
for (let i = 0; i < p.jobs; i++) insertJob.run();
console.log(`seeded ${dbPath} with preset '${preset}' (${p.items.length} items, ${p.jobs} jobs)`);
