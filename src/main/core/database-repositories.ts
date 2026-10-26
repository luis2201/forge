import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  databaseConnectionInputSchema,
  type DatabaseConnectionInput,
  type DatabaseConnectionProfile,
  type DatabaseHistoryEntry,
} from '../../shared/contracts.js';
import { AppError } from './errors.js';

type ConnectionRow = {
  id: string;
  workspace_id: string;
  name: string;
  engine: string;
  environment: string;
  host: string;
  port: number | null;
  database_name: string;
  username: string;
  ssl_mode: string;
  sqlite_path: string;
  secret_ref: string | null;
  created_at: number;
  updated_at: number;
  last_connected_at: number | null;
};

type HistoryRow = {
  id: string;
  connection_id: string | null;
  connection_name: string;
  statement: string;
  succeeded: number;
  duration_ms: number;
  row_count: number;
  error_code: string | null;
  executed_at: number;
};

export interface StoredDatabaseConnection extends DatabaseConnectionProfile {
  secretRef: string | null;
}

const iso = (value: number): string => new Date(value).toISOString();

export class DatabaseConnectionRepository {
  constructor(private readonly db: Database.Database) {}

  list(workspaceId: string): StoredDatabaseConnection[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM database_connections WHERE workspace_id=? ORDER BY name COLLATE NOCASE',
      )
      .all(workspaceId) as ConnectionRow[];
    return rows.map((row) => this.map(row));
  }

  find(workspaceId: string, connectionId: string): StoredDatabaseConnection | null {
    const row = this.db
      .prepare('SELECT * FROM database_connections WHERE id=? AND workspace_id=?')
      .get(connectionId, workspaceId) as ConnectionRow | undefined;
    return row ? this.map(row) : null;
  }

  save(
    workspaceId: string,
    connectionId: string | null,
    input: DatabaseConnectionInput,
    secretRef: string | null,
  ): StoredDatabaseConnection {
    const profile = databaseConnectionInputSchema.parse(input);
    const now = Date.now();
    const id = connectionId ?? randomUUID();
    const existing = connectionId ? this.find(workspaceId, connectionId) : null;
    if (connectionId && !existing) {
      throw new AppError('DATABASE_CONNECTION_NOT_FOUND', 'La conexión ya no está disponible.');
    }
    try {
      this.db
        .prepare(
          `INSERT INTO database_connections(
             id, workspace_id, name, engine, environment, host, port, database_name,
             username, ssl_mode, sqlite_path, secret_ref, created_at, updated_at, last_connected_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, engine=excluded.engine, environment=excluded.environment,
             host=excluded.host, port=excluded.port, database_name=excluded.database_name,
             username=excluded.username, ssl_mode=excluded.ssl_mode,
             sqlite_path=excluded.sqlite_path, secret_ref=excluded.secret_ref,
             updated_at=excluded.updated_at`,
        )
        .run(
          id,
          workspaceId,
          profile.name,
          profile.engine,
          profile.environment,
          profile.host,
          profile.port,
          profile.database,
          profile.username,
          profile.sslMode,
          profile.sqlitePath,
          secretRef,
          existing ? Date.parse(existing.createdAt) : now,
          now,
          existing?.lastConnectedAt ? Date.parse(existing.lastConnectedAt) : null,
        );
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new AppError(
          'DATABASE_CONNECTION_NAME_EXISTS',
          'Ya existe una conexión con ese nombre en el workspace.',
        );
      }
      throw error;
    }
    return this.require(workspaceId, id);
  }

  touchConnected(workspaceId: string, connectionId: string): StoredDatabaseConnection {
    const now = Date.now();
    const changed = this.db
      .prepare(
        'UPDATE database_connections SET last_connected_at=?, updated_at=? WHERE id=? AND workspace_id=?',
      )
      .run(now, now, connectionId, workspaceId);
    if (changed.changes === 0) {
      throw new AppError('DATABASE_CONNECTION_NOT_FOUND', 'La conexión ya no está disponible.');
    }
    return this.require(workspaceId, connectionId);
  }

  delete(workspaceId: string, connectionId: string): string | null {
    const existing = this.require(workspaceId, connectionId);
    this.db
      .prepare('DELETE FROM database_connections WHERE id=? AND workspace_id=?')
      .run(connectionId, workspaceId);
    return existing.secretRef;
  }

  private require(workspaceId: string, connectionId: string): StoredDatabaseConnection {
    const profile = this.find(workspaceId, connectionId);
    if (!profile) {
      throw new AppError('DATABASE_CONNECTION_NOT_FOUND', 'La conexión ya no está disponible.');
    }
    return profile;
  }

  private map(row: ConnectionRow): StoredDatabaseConnection {
    const input = databaseConnectionInputSchema.parse({
      name: row.name,
      engine: row.engine,
      environment: row.environment,
      host: row.host,
      port: row.port,
      database: row.database_name,
      username: row.username,
      sslMode: row.ssl_mode,
      sqlitePath: row.sqlite_path,
    });
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      ...input,
      hasPassword: Boolean(row.secret_ref),
      connected: false,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      lastConnectedAt: row.last_connected_at ? iso(row.last_connected_at) : null,
      secretRef: row.secret_ref,
    };
  }
}

export class DatabaseHistoryRepository {
  constructor(private readonly db: Database.Database) {}

  add(entry: {
    workspaceId: string;
    connectionId: string;
    connectionName: string;
    statement: string;
    succeeded: boolean;
    durationMs: number;
    rowCount: number;
    errorCode: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO database_query_history(
           id, workspace_id, connection_id, connection_name, statement, succeeded,
           duration_ms, row_count, error_code, executed_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        entry.workspaceId,
        entry.connectionId,
        entry.connectionName,
        entry.statement,
        entry.succeeded ? 1 : 0,
        Math.max(0, Math.round(entry.durationMs)),
        Math.max(0, entry.rowCount),
        entry.errorCode,
        Date.now(),
      );
    this.db
      .prepare(
        `DELETE FROM database_query_history
         WHERE workspace_id=? AND id NOT IN (
           SELECT id FROM database_query_history WHERE workspace_id=? ORDER BY executed_at DESC LIMIT 1000
         )`,
      )
      .run(entry.workspaceId, entry.workspaceId);
  }

  list(workspaceId: string, limit: number): DatabaseHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, connection_id, connection_name, statement, succeeded, duration_ms,
                row_count, error_code, executed_at
         FROM database_query_history WHERE workspace_id=? ORDER BY executed_at DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as HistoryRow[];
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      connectionName: row.connection_name,
      statement: row.statement,
      succeeded: row.succeeded === 1,
      durationMs: row.duration_ms,
      rowCount: row.row_count,
      errorCode: row.error_code,
      executedAt: iso(row.executed_at),
    }));
  }

  clear(workspaceId: string): void {
    this.db.prepare('DELETE FROM database_query_history WHERE workspace_id=?').run(workspaceId);
  }
}
