// Usage:
//   npm run migrate              Dry run: reads everything, changes nothing, prints a report.
//   npm run migrate -- --apply   Copies the data to MongoDB and images to Cloudinary.
//   npm run migrate -- --apply --refresh
//                                Also re-copies existing records. Overwrites edits made on
//                                the new site, except accounts. For the final copy before launch.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../lib/db.js';
import { migrate } from '../migration/migrate.js';
import { isImageStorageConfigured } from '../services/images.js';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const refresh = args.has('--refresh');
const legacyUrl = process.env.LEGACY_DATABASE_URL;
const projectRoot = resolve(process.cwd(), '..');

if (!legacyUrl) {
  console.error('Set LEGACY_DATABASE_URL in backend/.env first.');
  process.exit(1);
}
if (refresh && !apply) {
  console.error('--refresh only works together with --apply.');
  process.exit(1);
}
if (apply && !isImageStorageConfigured()) {
  console.error('Set the Cloudinary details in backend/.env before running with --apply.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: legacyUrl });
await client.connect();
// The database itself refuses any change for this whole connection.
await client.query('SET default_transaction_read_only = on');
await client.query('BEGIN TRANSACTION READ ONLY');
await connectDatabase(env.MONGODB_URI);

try {
  const report = await migrate({
    source: client,
    apply,
    refresh,
    uploadsDir: process.env.LEGACY_UPLOADS_DIR ?? join(projectRoot, 'migration', 'legacy-uploads'),
    legacySiteUrl: process.env.LEGACY_SITE_URL,
  });

  console.log(`\nMode: ${report.mode}${apply ? '' : ' (nothing was changed)'}\n`);
  console.table(report.tables);
  console.log('Images:', report.images);
  console.log(`Not copied on purpose: ${report.notMigrated.join(', ')}`);
  if (report.warnings.length) {
    console.log(`\n${report.warnings.length} warning(s). First 30:`);
    report.warnings.slice(0, 30).forEach((warning) => console.log(`  - ${warning}`));
  }

  // Old-database ids and image paths only, no customer names, emails or passwords.
  const folder = join(projectRoot, 'migration', 'reports');
  await mkdir(folder, { recursive: true });
  const file = join(folder, `${report.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(`\nFull report: ${file}`);
  console.log(report.ok ? 'Result: all records accounted for.' : 'Result: PROBLEMS FOUND. Read the warnings before continuing.');
  process.exitCode = report.ok ? 0 : 2;
} finally {
  await client.query('ROLLBACK').catch(() => undefined);
  await client.end();
  await disconnectDatabase();
}

// Library timers can keep Node running after the work is finished.
process.exit(process.exitCode ?? 0);
