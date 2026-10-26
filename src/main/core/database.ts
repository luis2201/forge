import Database from 'better-sqlite3';
import { AppError } from './errors.js';

const migrations = [
  {
    version: 1,
    name: 'phase-1-core',
    checksum: 'phase-1-core-v1',
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, last_opened_at INTEGER, is_archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE workspace_roots (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
        canonical_path TEXT NOT NULL UNIQUE COLLATE NOCASE, display_path TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE workspace_settings (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL, settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE application_settings (
        key TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE workspace_layouts (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL, layout_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'phase-4-database-workbench',
    checksum: 'phase-4-database-workbench-v1',
    sql: `
      CREATE TABLE secret_values (
        ref TEXT PRIMARY KEY,
        encrypted_value BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE database_connections (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        engine TEXT NOT NULL CHECK(engine IN ('mysql','postgresql','sqlite')),
        environment TEXT NOT NULL CHECK(environment IN ('LOCAL','DEVELOPMENT','TEST','STAGING','PRODUCTION')),
        host TEXT NOT NULL DEFAULT '',
        port INTEGER,
        database_name TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        ssl_mode TEXT NOT NULL DEFAULT 'disabled' CHECK(ssl_mode IN ('disabled','preferred','required')),
        sqlite_path TEXT NOT NULL DEFAULT '',
        secret_ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_connected_at INTEGER,
        UNIQUE(workspace_id, name COLLATE NOCASE)
      );
      CREATE INDEX database_connections_workspace_idx ON database_connections(workspace_id, updated_at DESC);
      CREATE TABLE database_query_history (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        connection_id TEXT REFERENCES database_connections(id) ON DELETE SET NULL,
        connection_name TEXT NOT NULL,
        statement TEXT NOT NULL,
        succeeded INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        row_count INTEGER NOT NULL,
        error_code TEXT,
        executed_at INTEGER NOT NULL
      );
      CREATE INDEX database_query_history_workspace_idx ON database_query_history(workspace_id, executed_at DESC);
    `,
  },
] as const;

export function openDatabase(filePath: string): Database.Database {
  const db = new Database(filePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  const current = tableExists
    ? ((
        db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
          version: number | null;
        }
      ).version ?? 0)
    : 0;
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    db.close();
    throw new AppError(
      'DATABASE_VERSION_UNSUPPORTED',
      'La base de datos fue creada por una versión más nueva de Forge.',
      ['Actualice Forge antes de continuar.'],
    );
  }
  for (const migration of migrations.filter((item) => item.version > current)) {
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, Date.now(), migration.checksum);
    })();
  }
}
