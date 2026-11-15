import { readdirSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

interface Migration { version: number; file: string }

function listMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .map((file) => ({ file, m: /^(\d+)-.+\.sql$/.exec(file) }))
    .filter((x): x is { file: string; m: RegExpExecArray } => x.m !== null)
    .map(({ file, m }) => ({ version: Number(m[1]), file }))
    .sort((a, b) => a.version - b.version);
}

export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

export function latestVersion(): number {
  return listMigrations().reduce((max, m) => Math.max(max, m.version), 0);
}

/** Apply pending numbered migrations in order, each in its own transaction. Returns the new version. */
export function migrate(db: DatabaseSync): number {
  let version = currentVersion(db);
  for (const m of listMigrations()) {
    if (m.version <= version) continue;
    const sql = readFileSync(new URL(m.file, MIGRATIONS_DIR), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      // version is parsed from our own file name as digits only, so interpolation is safe here.
      db.exec(`PRAGMA user_version = ${Math.trunc(m.version)}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    version = m.version;
  }
  return version;
}
