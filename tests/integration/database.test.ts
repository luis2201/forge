import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/core/database';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('database migrations', () => {
  it('creates the phase 4 schema and enables foreign keys', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'forge-db-'));
    created.push(folder);
    const db = openDatabase(join(folder, 'forge.db'));
    expect(
      (
        db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
          version: number;
        }
      ).version,
    ).toBe(2);
    expect(
      (
        db.prepare('SELECT checksum FROM schema_migrations WHERE version=1').get() as {
          checksum: string;
        }
      ).checksum,
    ).toBe('phase-1-core-v1');
    expect(
      (
        db.prepare('SELECT checksum FROM schema_migrations WHERE version=2').get() as {
          checksum: string;
        }
      ).checksum,
    ).toBe('phase-4-database-workbench-v1');
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('database_connections','database_query_history','secret_values')",
        )
        .all(),
    ).toHaveLength(3);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('refuses a database created by a newer Forge version', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'forge-db-'));
    created.push(folder);
    const path = join(folder, 'future.db');
    const seed = new Database(path);
    seed.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL); INSERT INTO schema_migrations VALUES(99,'future',0,'future')",
    );
    seed.close();
    expect(() => openDatabase(path)).toThrowError(/versión más nueva/);
  });
});
