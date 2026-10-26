import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import mysql, {
  type Connection as MysqlConnection,
  type FieldPacket,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import { Client as PostgresClient, type FieldDef, type QueryResult } from 'pg';
import {
  databaseConnectionInputSchema,
  type DatabaseCatalog,
  type DatabaseConnectionInput,
  type DatabaseConnectionProfile,
  type DatabaseHistoryEntry,
  type DatabaseImportPreview,
  type DatabaseObject,
  type DatabaseQueryResult,
  type DatabaseResultColumn,
  type DatabaseRowMutation,
  type DatabaseTableData,
  type DatabaseTableStructure,
  type DatabaseValue,
} from '../../shared/contracts.js';
import type {
  DatabaseConnectionRepository,
  DatabaseHistoryRepository,
  StoredDatabaseConnection,
} from './database-repositories.js';
import { AppError } from './errors.js';
import { normalizeRelativePath } from './filesystem.js';
import type { WorkspaceRepository } from './repositories.js';
import type { SecretStore } from './secrets.js';

const QUERY_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 8_000;
const MAX_RESULT_ROWS = 1_000;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 10_000;

type Session =
  | { engine: 'mysql'; client: MysqlConnection }
  | { engine: 'postgresql'; client: PostgresClient }
  | { engine: 'sqlite'; client: Database.Database };

type ImportBuffer = {
  workspaceId: string;
  fileName: string;
  format: 'csv' | 'json';
  columns: string[];
  rows: DatabaseValue[][];
  createdAt: number;
};

interface MysqlObjectRow extends RowDataPacket {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  TABLE_TYPE: string;
}

interface MysqlColumnRow extends RowDataPacket {
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_KEY: string;
  COLUMN_DEFAULT: unknown;
  EXTRA: string;
}

interface MysqlForeignKeyRow extends RowDataPacket {
  COLUMN_NAME: string;
  REFERENCED_TABLE_SCHEMA: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
}

export class DatabaseWorkbenchService {
  private readonly sessions = new Map<string, Session>();
  private readonly imports = new Map<string, ImportBuffer>();

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly connections: DatabaseConnectionRepository,
    private readonly historyRepository: DatabaseHistoryRepository,
    private readonly secrets: SecretStore,
  ) {}

  listConnections(workspaceId: string): DatabaseConnectionProfile[] {
    this.requireWorkspace(workspaceId);
    return this.connections.list(workspaceId).map((profile) => this.publicProfile(profile));
  }

  async saveConnection(
    workspaceId: string,
    connectionId: string | null,
    input: DatabaseConnectionInput,
    password?: string,
  ): Promise<DatabaseConnectionProfile> {
    this.requireWorkspace(workspaceId);
    const parsed = databaseConnectionInputSchema.parse(input);
    const existing = connectionId ? this.connections.find(workspaceId, connectionId) : null;
    if (connectionId && !existing) {
      throw new AppError('DATABASE_CONNECTION_NOT_FOUND', 'La conexión ya no está disponible.');
    }
    if (connectionId) await this.disconnect(workspaceId, connectionId);
    const secretRef =
      existing?.secretRef ??
      `forge:workspace:${workspaceId}:database:${connectionId ?? randomUUID()}:password`;
    let storedRef = password === undefined ? (existing?.secretRef ?? null) : secretRef;
    if (parsed.engine === 'sqlite') {
      if (existing?.secretRef) await this.secrets.delete(existing.secretRef);
      storedRef = null;
    } else if (password !== undefined) {
      if (password) await this.secrets.set(secretRef, password);
      else await this.secrets.delete(secretRef);
    }
    try {
      const stored = this.connections.save(
        workspaceId,
        connectionId,
        parsed,
        password === '' ? null : storedRef,
      );
      return this.publicProfile(stored);
    } catch (error) {
      if (!existing && storedRef) await this.secrets.delete(storedRef);
      throw error;
    }
  }

  async deleteConnection(
    workspaceId: string,
    connectionId: string,
    confirmed: boolean,
  ): Promise<void> {
    this.requireWorkspace(workspaceId);
    if (!confirmed) {
      throw new AppError(
        'DATABASE_CONFIRMATION_REQUIRED',
        'Eliminar la conexión requiere confirmación explícita.',
        ['Se eliminará el perfil y su credencial guardada; la base de datos no será modificada.'],
      );
    }
    await this.disconnect(workspaceId, connectionId);
    const secretRef = this.connections.delete(workspaceId, connectionId);
    if (secretRef) await this.secrets.delete(secretRef);
  }

  async testConnection(
    workspaceId: string,
    input: DatabaseConnectionInput,
    password?: string,
  ): Promise<void> {
    this.requireWorkspace(workspaceId);
    const parsed = databaseConnectionInputSchema.parse(input);
    const profile = this.transientProfile(workspaceId, parsed);
    const session = await this.open(profile, password ?? null);
    try {
      await this.ping(session);
    } finally {
      await closeSession(session);
    }
  }

  async connect(workspaceId: string, connectionId: string): Promise<DatabaseConnectionProfile> {
    const profile = this.requireConnection(workspaceId, connectionId);
    if (this.sessions.has(connectionId)) return this.publicProfile(profile);
    const password = profile.secretRef ? await this.secrets.get(profile.secretRef) : null;
    const session = await this.open(profile, password);
    try {
      await this.ping(session);
      this.sessions.set(connectionId, session);
      return this.publicProfile(this.connections.touchConnected(workspaceId, connectionId));
    } catch (error) {
      await closeSession(session);
      throw error;
    }
  }

  async disconnect(workspaceId: string, connectionId: string): Promise<void> {
    this.requireConnection(workspaceId, connectionId);
    const session = this.sessions.get(connectionId);
    this.sessions.delete(connectionId);
    if (session) await closeSession(session);
  }

  async disconnectWorkspace(workspaceId: string): Promise<void> {
    const ids = this.connections.list(workspaceId).map((profile) => profile.id);
    await Promise.all(
      ids.map(async (id) => {
        const session = this.sessions.get(id);
        this.sessions.delete(id);
        if (session) await closeSession(session);
      }),
    );
  }

  async catalog(workspaceId: string, connectionId: string): Promise<DatabaseCatalog> {
    const { profile, session } = await this.requireSession(workspaceId, connectionId);
    if (session.engine === 'mysql') {
      const [rows] = await session.client.query<MysqlObjectRow[]>(
        `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
         FROM information_schema.TABLES WHERE TABLE_SCHEMA=?
         ORDER BY TABLE_TYPE, TABLE_NAME`,
        [profile.database],
      );
      const objects = rows.map((row): DatabaseObject => ({
        schema: row.TABLE_SCHEMA,
        name: row.TABLE_NAME,
        type: row.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
      }));
      return {
        engine: profile.engine,
        database: profile.database,
        schemas: [profile.database],
        objects,
      };
    }
    if (session.engine === 'postgresql') {
      const result = await session.client.query<{
        table_schema: string;
        table_name: string;
        table_type: string;
      }>(
        `SELECT table_schema, table_name, table_type
         FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog','information_schema')
         ORDER BY table_schema, table_type, table_name`,
      );
      const objects = result.rows.map((row): DatabaseObject => ({
        schema: row.table_schema,
        name: row.table_name,
        type: row.table_type === 'VIEW' ? 'view' : 'table',
      }));
      return {
        engine: profile.engine,
        database: profile.database,
        schemas: [...new Set(objects.map((object) => object.schema))],
        objects,
      };
    }
    const rows = session.client
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all() as Array<{ name: string; type: string }>;
    return {
      engine: profile.engine,
      database: profile.sqlitePath,
      schemas: ['main'],
      objects: rows.map((row) => ({
        schema: 'main',
        name: row.name,
        type: row.type === 'view' ? 'view' : 'table',
      })),
    };
  }

  async structure(
    workspaceId: string,
    connectionId: string,
    schema: string,
    table: string,
  ): Promise<DatabaseTableStructure> {
    const { session } = await this.requireSession(workspaceId, connectionId);
    const catalog = await this.catalog(workspaceId, connectionId);
    const object = catalog.objects.find((item) => item.schema === schema && item.name === table);
    if (!object) throw new AppError('DATABASE_OBJECT_NOT_FOUND', 'La tabla o vista ya no existe.');
    if (session.engine === 'mysql') {
      const [columnRows] = await session.client.query<MysqlColumnRow[]>(
        `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`,
        [schema, table],
      );
      const [foreignRows] = await session.client.query<MysqlForeignKeyRow[]>(
        `SELECT COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [schema, table],
      );
      return {
        schema,
        name: table,
        type: object.type,
        columns: columnRows.map((row) => ({
          name: row.COLUMN_NAME,
          dataType: row.COLUMN_TYPE,
          nullable: row.IS_NULLABLE === 'YES',
          primaryKey: row.COLUMN_KEY === 'PRI',
          defaultValue: metadataValue(row.COLUMN_DEFAULT),
          generated: row.EXTRA.toLowerCase().includes('generated'),
          autoIncrement: row.EXTRA.toLowerCase().includes('auto_increment'),
        })),
        foreignKeys: foreignRows.map((row) => ({
          column: row.COLUMN_NAME,
          referencedSchema: row.REFERENCED_TABLE_SCHEMA,
          referencedTable: row.REFERENCED_TABLE_NAME,
          referencedColumn: row.REFERENCED_COLUMN_NAME,
        })),
      };
    }
    if (session.engine === 'postgresql') {
      const columnResult = await session.client.query<{
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
        is_generated: string;
        is_identity: string;
      }>(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default, is_generated, is_identity
           FROM information_schema.columns
           WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
        [schema, table],
      );
      const keyResult = await session.client.query<{ column_name: string }>(
        `SELECT a.attname AS column_name
           FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
           JOIN pg_namespace n ON n.oid=c.relnamespace
           JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=ANY(i.indkey)
           WHERE i.indisprimary AND n.nspname=$1 AND c.relname=$2`,
        [schema, table],
      );
      const foreignResult = await session.client.query<{
        column_name: string;
        foreign_table_schema: string;
        foreign_table_name: string;
        foreign_column_name: string;
      }>(
        `SELECT kcu.column_name, ccu.table_schema AS foreign_table_schema,
                  ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema
           WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=$1 AND tc.table_name=$2`,
        [schema, table],
      );
      const primaryKeys = new Set(keyResult.rows.map((row) => row.column_name));
      return {
        schema,
        name: table,
        type: object.type,
        columns: columnResult.rows.map((row) => ({
          name: row.column_name,
          dataType: row.data_type === 'USER-DEFINED' ? row.udt_name : row.data_type,
          nullable: row.is_nullable === 'YES',
          primaryKey: primaryKeys.has(row.column_name),
          defaultValue: row.column_default,
          generated: row.is_generated !== 'NEVER',
          autoIncrement:
            row.is_identity === 'YES' || Boolean(row.column_default?.startsWith('nextval(')),
        })),
        foreignKeys: foreignResult.rows.map((row) => ({
          column: row.column_name,
          referencedSchema: row.foreign_table_schema,
          referencedTable: row.foreign_table_name,
          referencedColumn: row.foreign_column_name,
        })),
      };
    }
    const columns = session.client
      .prepare(`PRAGMA table_info(${quoteIdentifier('sqlite', table)})`)
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const foreignKeys = session.client
      .prepare(`PRAGMA foreign_key_list(${quoteIdentifier('sqlite', table)})`)
      .all() as Array<{ from: string; table: string; to: string }>;
    return {
      schema,
      name: table,
      type: object.type,
      columns: columns.map((column) => ({
        name: column.name,
        dataType: column.type || 'ANY',
        nullable: column.notnull === 0,
        primaryKey: column.pk > 0,
        defaultValue: column.dflt_value,
        generated: false,
        autoIncrement: column.pk > 0 && /INT/i.test(column.type),
      })),
      foreignKeys: foreignKeys.map((key) => ({
        column: key.from,
        referencedSchema: 'main',
        referencedTable: key.table,
        referencedColumn: key.to,
      })),
    };
  }

  async query(
    workspaceId: string,
    connectionId: string,
    statement: string,
    confirmed: boolean,
  ): Promise<DatabaseQueryResult> {
    const profile = this.requireConnection(workspaceId, connectionId);
    assertSingleStatement(statement);
    const risk = assessStatement(statement);
    requireSqlConfirmation(profile, risk, confirmed);
    const started = performance.now();
    try {
      const { session } = await this.requireSession(workspaceId, connectionId);
      const result = await executeFreeQuery(session, boundedReadStatement(statement, risk));
      result.durationMs = Math.round(performance.now() - started);
      this.recordHistory(profile, statement, true, result.durationMs, result.rowCount, null);
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      const mapped = mapDatabaseError(error, profile);
      this.recordHistory(profile, statement, false, durationMs, 0, mapped.code);
      throw mapped;
    }
  }

  async tableData(
    workspaceId: string,
    connectionId: string,
    schema: string,
    table: string,
    offset: number,
    limit: number,
  ): Promise<DatabaseTableData> {
    const profile = this.requireConnection(workspaceId, connectionId);
    const structure = await this.structure(workspaceId, connectionId, schema, table);
    const engine = profile.engine;
    const qualified = qualify(engine, schema, table);
    const statement = `SELECT * FROM ${qualified} LIMIT ${Math.min(limit, MAX_RESULT_ROWS) + 1} OFFSET ${offset}`;
    const { session } = await this.requireSession(workspaceId, connectionId);
    const result = await executeFreeQuery(session, statement);
    const hasMore = result.rows.length > limit;
    if (hasMore) {
      result.rows = result.rows.slice(0, limit);
      result.rowCount = result.rows.length;
    }
    result.truncated = hasMore;
    return { structure, result, offset, limit };
  }

  async mutateRow(
    workspaceId: string,
    connectionId: string,
    schema: string,
    table: string,
    mutation: DatabaseRowMutation,
    confirmed: boolean,
  ): Promise<DatabaseQueryResult> {
    const profile = this.requireConnection(workspaceId, connectionId);
    if (profile.environment === 'PRODUCTION' && !confirmed) {
      throw new AppError(
        'DATABASE_PRODUCTION_CONFIRMATION_REQUIRED',
        'Modificar datos en PRODUCCIÓN requiere confirmación explícita.',
        ['Revise la conexión, tabla y valores antes de continuar.'],
      );
    }
    if (mutation.kind === 'delete' && !confirmed) {
      throw new AppError(
        'DATABASE_CONFIRMATION_REQUIRED',
        'Eliminar una fila requiere confirmación explícita.',
        ['La operación se ejecutará directamente en la base de datos.'],
      );
    }
    const structure = await this.structure(workspaceId, connectionId, schema, table);
    if (structure.type === 'view') {
      throw new AppError(
        'DATABASE_VIEW_READ_ONLY',
        'La edición visual de vistas no está habilitada.',
      );
    }
    const columns = new Set(structure.columns.map((column) => column.name));
    const primaryKeys = structure.columns
      .filter((column) => column.primaryKey)
      .map((column) => column.name);
    const validateValues = (values: Record<string, DatabaseValue>) => {
      for (const key of Object.keys(values)) {
        if (!columns.has(key)) {
          throw new AppError('DATABASE_COLUMN_NOT_FOUND', `La columna ${key} ya no existe.`);
        }
      }
    };
    const engine = profile.engine;
    const target = qualify(engine, schema, table);
    let sql: string;
    let parameters: DatabaseValue[];
    if (mutation.kind === 'insert') {
      validateValues(mutation.values);
      const entries = Object.entries(mutation.values);
      parameters = entries.map(([, value]) => value);
      sql =
        entries.length === 0
          ? engine === 'mysql'
            ? `INSERT INTO ${target} () VALUES ()`
            : `INSERT INTO ${target} DEFAULT VALUES`
          : `INSERT INTO ${target} (${entries.map(([name]) => quoteIdentifier(engine, name)).join(', ')}) VALUES (${placeholders(engine, entries.length)})`;
    } else {
      validateValues(mutation.key);
      if (primaryKeys.length === 0 || primaryKeys.some((key) => !(key in mutation.key))) {
        throw new AppError(
          'DATABASE_PRIMARY_KEY_REQUIRED',
          'La tabla necesita una clave primaria completa para editar filas con seguridad.',
        );
      }
      const keyEntries = primaryKeys.map((key) => [key, mutation.key[key] ?? null] as const);
      if (mutation.kind === 'delete') {
        parameters = keyEntries.filter(([, value]) => value !== null).map(([, value]) => value);
        sql = `DELETE FROM ${target} WHERE ${whereClause(engine, keyEntries, 0)}`;
      } else {
        validateValues(mutation.values);
        const entries = Object.entries(mutation.values);
        if (entries.length === 0) {
          throw new AppError('DATABASE_VALUES_REQUIRED', 'No hay valores para actualizar.');
        }
        parameters = [
          ...entries.map(([, value]) => value),
          ...keyEntries.filter(([, value]) => value !== null).map(([, value]) => value),
        ];
        const assignments = entries
          .map(
            ([name], index) => `${quoteIdentifier(engine, name)}=${placeholder(engine, index + 1)}`,
          )
          .join(', ');
        sql = `UPDATE ${target} SET ${assignments} WHERE ${whereClause(engine, keyEntries, entries.length)}`;
      }
    }
    const { session } = await this.requireSession(workspaceId, connectionId);
    const started = performance.now();
    try {
      const result = await executeParameterized(session, sql, parameters);
      result.durationMs = Math.round(performance.now() - started);
      this.recordHistory(profile, sql, true, result.durationMs, result.rowCount, null);
      return result;
    } catch (error) {
      const mapped = mapDatabaseError(error, profile);
      this.recordHistory(
        profile,
        sql,
        false,
        Math.round(performance.now() - started),
        0,
        mapped.code,
      );
      throw mapped;
    }
  }

  history(workspaceId: string, limit: number): DatabaseHistoryEntry[] {
    this.requireWorkspace(workspaceId);
    return this.historyRepository.list(workspaceId, limit);
  }

  clearHistory(workspaceId: string, confirmed: boolean): void {
    this.requireWorkspace(workspaceId);
    if (!confirmed) {
      throw new AppError(
        'DATABASE_CONFIRMATION_REQUIRED',
        'Limpiar el historial SQL requiere confirmación explícita.',
      );
    }
    this.historyRepository.clear(workspaceId);
  }

  async previewImport(workspaceId: string, filePath: string): Promise<DatabaseImportPreview> {
    this.requireWorkspace(workspaceId);
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_IMPORT_BYTES) {
      throw new AppError(
        'DATABASE_IMPORT_TOO_LARGE',
        'El archivo de importación debe ser CSV o JSON y no superar 5 MB.',
      );
    }
    const content = await readFile(filePath, 'utf8');
    const format = filePath.toLowerCase().endsWith('.json') ? 'json' : 'csv';
    const parsed = format === 'json' ? parseJsonImport(content) : parseCsvImport(content);
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      throw new AppError(
        'DATABASE_IMPORT_ROW_LIMIT',
        `La importación básica admite hasta ${MAX_IMPORT_ROWS} filas por operación.`,
      );
    }
    const importId = randomUUID();
    const fileName = filePath.split(/[\\/]/).at(-1) ?? 'import';
    this.pruneImports();
    this.imports.set(importId, {
      workspaceId,
      fileName,
      format,
      columns: parsed.columns,
      rows: parsed.rows,
      createdAt: Date.now(),
    });
    return {
      importId,
      fileName,
      format,
      columns: parsed.columns,
      rows: parsed.rows.slice(0, 50),
      totalRows: parsed.rows.length,
      truncated: parsed.rows.length > 50,
    };
  }

  async applyImport(
    workspaceId: string,
    connectionId: string,
    importId: string,
    schema: string,
    table: string,
    confirmed: boolean,
  ): Promise<DatabaseQueryResult> {
    const profile = this.requireConnection(workspaceId, connectionId);
    if (profile.environment === 'PRODUCTION' && !confirmed) {
      throw new AppError(
        'DATABASE_PRODUCTION_CONFIRMATION_REQUIRED',
        'Importar datos en PRODUCCIÓN requiere confirmación explícita.',
      );
    }
    const imported = this.imports.get(importId);
    if (
      !imported ||
      imported.workspaceId !== workspaceId ||
      Date.now() - imported.createdAt > 15 * 60_000
    ) {
      throw new AppError('DATABASE_IMPORT_EXPIRED', 'La previsualización de importación expiró.', [
        'Seleccione nuevamente el archivo.',
      ]);
    }
    const structure = await this.structure(workspaceId, connectionId, schema, table);
    const available = new Set(structure.columns.map((column) => column.name));
    if (imported.columns.some((column) => !available.has(column))) {
      throw new AppError(
        'DATABASE_IMPORT_COLUMNS_MISMATCH',
        'El archivo contiene columnas que no existen en la tabla seleccionada.',
      );
    }
    const { session } = await this.requireSession(workspaceId, connectionId);
    const engine = profile.engine;
    const sql = `INSERT INTO ${qualify(engine, schema, table)} (${imported.columns
      .map((column) => quoteIdentifier(engine, column))
      .join(', ')}) VALUES (${placeholders(engine, imported.columns.length)})`;
    const started = performance.now();
    let affectedRows = 0;
    try {
      await begin(session);
      for (const row of imported.rows) {
        const result = await executeParameterized(session, sql, row);
        affectedRows += result.affectedRows;
      }
      await commit(session);
      this.imports.delete(importId);
      const durationMs = Math.round(performance.now() - started);
      this.recordHistory(
        profile,
        `IMPORT ${imported.fileName} INTO ${schema}.${table}`,
        true,
        durationMs,
        affectedRows,
        null,
      );
      return {
        kind: 'mutation',
        columns: [],
        rows: [],
        rowCount: affectedRows,
        affectedRows,
        durationMs,
        truncated: false,
        command: 'IMPORT',
      };
    } catch (error) {
      await rollback(session).catch(() => undefined);
      const mapped = mapDatabaseError(error, profile);
      this.recordHistory(
        profile,
        `IMPORT ${imported.fileName} INTO ${schema}.${table}`,
        false,
        Math.round(performance.now() - started),
        0,
        mapped.code,
      );
      throw mapped;
    }
  }

  async exportResult(
    workspaceId: string,
    connectionId: string,
    format: 'csv' | 'json',
    columns: string[],
    rows: DatabaseValue[][],
    filePath: string,
  ): Promise<void> {
    this.requireConnection(workspaceId, connectionId);
    const content = format === 'json' ? toJson(columns, rows) : toCsv(columns, rows);
    await writeFile(filePath, content, 'utf8');
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.imports.clear();
    await Promise.all(sessions.map((session) => closeSession(session)));
  }

  private async open(profile: StoredDatabaseConnection, password: string | null): Promise<Session> {
    try {
      if (profile.engine === 'mysql') {
        const client = await mysql.createConnection({
          host: profile.host,
          port: profile.port ?? 3306,
          user: profile.username,
          ...(password === null ? {} : { password }),
          database: profile.database,
          connectTimeout: CONNECT_TIMEOUT_MS,
          multipleStatements: false,
          charset: 'utf8mb4',
          ...(profile.sslMode === 'disabled'
            ? {}
            : { ssl: { rejectUnauthorized: profile.sslMode === 'required' } }),
        });
        return { engine: 'mysql', client };
      }
      if (profile.engine === 'postgresql') {
        const client = new PostgresClient({
          host: profile.host,
          port: profile.port ?? 5432,
          user: profile.username,
          password: password ?? undefined,
          database: profile.database,
          connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
          statement_timeout: QUERY_TIMEOUT_MS,
          query_timeout: QUERY_TIMEOUT_MS,
          application_name: 'Forge',
          ...(profile.sslMode === 'disabled'
            ? {}
            : { ssl: { rejectUnauthorized: profile.sslMode === 'required' } }),
        });
        await client.connect();
        client.on('error', () => this.sessions.delete(profile.id));
        return { engine: 'postgresql', client };
      }
      const path = await this.sqlitePath(profile);
      const client = new Database(path, { timeout: 5_000 });
      client.pragma('foreign_keys = ON');
      client.pragma('busy_timeout = 5000');
      return { engine: 'sqlite', client };
    } catch (error) {
      throw mapDatabaseError(error, profile);
    }
  }

  private async sqlitePath(profile: StoredDatabaseConnection): Promise<string> {
    const workspace = this.requireWorkspace(profile.workspaceId);
    const requested = normalizeRelativePath(profile.sqlitePath);
    const candidate = join(workspace.rootPath, ...requested.split('/'));
    const root = await realpath(workspace.rootPath);
    let comparable: string;
    try {
      comparable = await realpath(candidate);
    } catch {
      const parent = await realpath(dirname(candidate));
      comparable = join(parent, candidate.slice(dirname(candidate).length + 1));
    }
    const child = relative(root, comparable);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new AppError(
        'PATH_OUTSIDE_WORKSPACE',
        'La base SQLite debe estar dentro del workspace autorizado.',
      );
    }
    return comparable;
  }

  private async ping(session: Session): Promise<void> {
    if (session.engine === 'mysql') await session.client.query('SELECT 1');
    else if (session.engine === 'postgresql') await session.client.query('SELECT 1');
    else session.client.prepare('SELECT 1').get();
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.workspaces.findById(workspaceId);
    if (!workspace)
      throw new AppError('WORKSPACE_NOT_FOUND', 'El workspace ya no está disponible.');
    return workspace;
  }

  private requireConnection(workspaceId: string, connectionId: string): StoredDatabaseConnection {
    this.requireWorkspace(workspaceId);
    const profile = this.connections.find(workspaceId, connectionId);
    if (!profile)
      throw new AppError('DATABASE_CONNECTION_NOT_FOUND', 'La conexión ya no está disponible.');
    return profile;
  }

  private async requireSession(
    workspaceId: string,
    connectionId: string,
  ): Promise<{ profile: StoredDatabaseConnection; session: Session }> {
    const profile = this.requireConnection(workspaceId, connectionId);
    if (!this.sessions.has(connectionId)) await this.connect(workspaceId, connectionId);
    const session = this.sessions.get(connectionId);
    if (!session) throw new AppError('DATABASE_NOT_CONNECTED', 'La conexión no está activa.');
    return { profile, session };
  }

  private publicProfile(profile: StoredDatabaseConnection): DatabaseConnectionProfile {
    const { secretRef, ...publicProfile } = profile;
    void secretRef;
    return { ...publicProfile, connected: this.sessions.has(profile.id) };
  }

  private transientProfile(
    workspaceId: string,
    input: DatabaseConnectionInput,
  ): StoredDatabaseConnection {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      workspaceId,
      ...input,
      hasPassword: false,
      connected: false,
      createdAt: now,
      updatedAt: now,
      lastConnectedAt: null,
      secretRef: null,
    };
  }

  private recordHistory(
    profile: StoredDatabaseConnection,
    statement: string,
    succeeded: boolean,
    durationMs: number,
    rowCount: number,
    errorCode: string | null,
  ): void {
    this.historyRepository.add({
      workspaceId: profile.workspaceId,
      connectionId: profile.id,
      connectionName: profile.name,
      statement,
      succeeded,
      durationMs,
      rowCount,
      errorCode,
    });
  }

  private pruneImports(): void {
    const expiry = Date.now() - 15 * 60_000;
    for (const [id, imported] of this.imports) {
      if (imported.createdAt < expiry) this.imports.delete(id);
    }
  }
}

function assertSingleStatement(statement: string): void {
  let mode: 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment' =
    'normal';
  let dollarDelimiter: string | null = null;
  let terminated = false;
  for (let index = 0; index < statement.length; index += 1) {
    const character = statement[index] ?? '';
    const next = statement[index + 1] ?? '';
    if (dollarDelimiter) {
      if (statement.startsWith(dollarDelimiter, index)) {
        index += dollarDelimiter.length - 1;
        dollarDelimiter = null;
      }
      continue;
    }
    if (mode === 'line-comment') {
      if (character === '\n') mode = 'normal';
      continue;
    }
    if (mode === 'block-comment') {
      if (character === '*' && next === '/') {
        mode = 'normal';
        index += 1;
      }
      continue;
    }
    if (mode !== 'normal') {
      const delimiter = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
      if (character === delimiter && next === delimiter) {
        index += 1;
      } else if (character === delimiter && statement[index - 1] !== '\\') {
        mode = 'normal';
      }
      continue;
    }
    if (character === '-' && next === '-') {
      mode = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      mode = 'block-comment';
      index += 1;
      continue;
    }
    if (character === "'") {
      if (terminated) throwMultipleStatements();
      mode = 'single';
      continue;
    }
    if (character === '"') {
      if (terminated) throwMultipleStatements();
      mode = 'double';
      continue;
    }
    if (character === '`') {
      if (terminated) throwMultipleStatements();
      mode = 'backtick';
      continue;
    }
    if (character === '$') {
      const delimiter = statement.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (delimiter) {
        if (terminated) throwMultipleStatements();
        dollarDelimiter = delimiter;
        index += delimiter.length - 1;
        continue;
      }
    }
    if (character === ';') {
      terminated = true;
      continue;
    }
    if (terminated && !/\s/u.test(character)) throwMultipleStatements();
  }
}

function throwMultipleStatements(): never {
  throw new AppError('DATABASE_MULTIPLE_STATEMENTS', 'Ejecute una sentencia SQL a la vez.', [
    'Seleccione y ejecute cada sentencia por separado para conservar resultados y confirmaciones claros.',
  ]);
}

function assessStatement(statement: string): {
  write: boolean;
  destructive: boolean;
  command: string;
} {
  const withoutComments = statement
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, '')
    .trim();
  const command = withoutComments.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? 'SQL';
  const destructive = /\b(DROP|TRUNCATE|DELETE|ALTER|REVOKE)\b/i.test(withoutComments);
  const write =
    destructive ||
    /\b(INSERT|UPDATE|REPLACE|CREATE|GRANT|VACUUM|ATTACH|DETACH|MERGE|CALL|COPY|LOAD\s+DATA|FOR\s+UPDATE|INTO\s+(?:OUTFILE|DUMPFILE))\b/i.test(
      withoutComments,
    ) ||
    (command === 'PRAGMA' && withoutComments.includes('=')) ||
    !['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'PRAGMA'].includes(command);
  return { write, destructive, command };
}

function boundedReadStatement(statement: string, risk: ReturnType<typeof assessStatement>): string {
  if (risk.write || !['SELECT', 'WITH'].includes(risk.command)) return statement;
  const normalized = statement.trim().replace(/;+\s*$/, '');
  return `SELECT * FROM (${normalized}) AS forge_bounded_result LIMIT ${MAX_RESULT_ROWS + 1}`;
}

function requireSqlConfirmation(
  profile: StoredDatabaseConnection,
  risk: ReturnType<typeof assessStatement>,
  confirmed: boolean,
): void {
  if (risk.write && profile.environment === 'PRODUCTION' && !confirmed) {
    throw new AppError(
      'DATABASE_PRODUCTION_CONFIRMATION_REQUIRED',
      `La sentencia ${risk.command} modificará una conexión de PRODUCCIÓN.`,
      ['Revise el SQL completo y confirme explícitamente la ejecución.'],
      { connection: profile.name, environment: profile.environment, command: risk.command },
    );
  }
  if (risk.destructive && !confirmed) {
    throw new AppError(
      'DATABASE_CONFIRMATION_REQUIRED',
      `La sentencia ${risk.command} puede eliminar o alterar datos.`,
      ['Revise el SQL completo y confirme explícitamente la ejecución.'],
      { connection: profile.name, environment: profile.environment, command: risk.command },
    );
  }
}

async function executeFreeQuery(session: Session, statement: string): Promise<DatabaseQueryResult> {
  if (session.engine === 'mysql') {
    const [rows, fields] = await session.client.query({
      sql: statement,
      rowsAsArray: true,
      timeout: QUERY_TIMEOUT_MS,
    });
    if (Array.isArray(rows)) return rowsResult(fields ?? [], rows as unknown[][], 'SQL');
    return mutationResult((rows as ResultSetHeader).affectedRows ?? 0, 'SQL');
  }
  if (session.engine === 'postgresql') {
    const raw = (await session.client.query({ text: statement, rowMode: 'array' })) as unknown as
      QueryResult<unknown[]> | QueryResult<unknown[]>[];
    const result = Array.isArray(raw) ? raw.at(-1) : raw;
    if (!result) return mutationResult(0, 'SQL');
    if (result.fields.length > 0) {
      return pgRowsResult(result.fields, result.rows, result.command);
    }
    return mutationResult(result.rowCount ?? 0, result.command);
  }
  const prepared = session.client.prepare(statement);
  if (prepared.reader) {
    const rows = prepared.raw(true).all() as unknown[][];
    const columns = prepared
      .columns()
      .map((column) => ({ name: column.name, dataType: column.type ?? 'ANY' }));
    return normalizedRowsResult(
      columns,
      rows,
      statement.trim().split(/\s+/)[0]?.toUpperCase() ?? 'SQL',
    );
  }
  const info = prepared.run();
  return mutationResult(info.changes, statement.trim().split(/\s+/)[0]?.toUpperCase() ?? 'SQL');
}

async function executeParameterized(
  session: Session,
  statement: string,
  parameters: DatabaseValue[],
): Promise<DatabaseQueryResult> {
  if (session.engine === 'mysql') {
    const [rows, fields] = await session.client.execute(
      { sql: statement, rowsAsArray: true },
      parameters,
    );
    if (Array.isArray(rows)) return rowsResult(fields ?? [], rows as unknown[][], 'SQL');
    return mutationResult((rows as ResultSetHeader).affectedRows ?? 0, 'SQL');
  }
  if (session.engine === 'postgresql') {
    const result = await session.client.query({
      text: statement,
      values: parameters,
      rowMode: 'array',
    });
    if (result.fields.length > 0)
      return pgRowsResult(result.fields, result.rows as unknown[][], result.command);
    return mutationResult(result.rowCount ?? 0, result.command);
  }
  const prepared = session.client.prepare(statement);
  const sqliteParameters = parameters.map((value) =>
    typeof value === 'boolean' ? Number(value) : value,
  );
  if (prepared.reader) {
    const rows = prepared.raw(true).all(...sqliteParameters) as unknown[][];
    const columns = prepared
      .columns()
      .map((column) => ({ name: column.name, dataType: column.type ?? 'ANY' }));
    return normalizedRowsResult(columns, rows, 'SQL');
  }
  return mutationResult(prepared.run(...sqliteParameters).changes, 'SQL');
}

function rowsResult(
  fields: FieldPacket[],
  rows: unknown[][],
  command: string,
): DatabaseQueryResult {
  return normalizedRowsResult(
    fields.map((field) => ({ name: field.name, dataType: String(field.type) })),
    rows,
    command,
  );
}

function pgRowsResult(fields: FieldDef[], rows: unknown[][], command: string): DatabaseQueryResult {
  return normalizedRowsResult(
    fields.map((field) => ({ name: field.name, dataType: String(field.dataTypeID) })),
    rows,
    command,
  );
}

function normalizedRowsResult(
  columns: DatabaseResultColumn[],
  rawRows: unknown[][],
  command: string,
): DatabaseQueryResult {
  const truncated = rawRows.length > MAX_RESULT_ROWS;
  const rows = rawRows.slice(0, MAX_RESULT_ROWS).map((row) => row.map(normalizeValue));
  return {
    kind: 'rows',
    columns,
    rows,
    rowCount: rows.length,
    affectedRows: 0,
    durationMs: 0,
    truncated,
    command,
  };
}

function mutationResult(affectedRows: number, command: string): DatabaseQueryResult {
  return {
    kind: 'mutation',
    columns: [],
    rows: [],
    rowCount: affectedRows,
    affectedRows,
    durationMs: 0,
    truncated: false,
    command,
  };
}

function normalizeValue(value: unknown): DatabaseValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : value.toString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[binario:${value.length} bytes]`;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[valor no serializable]';
    }
  }
  if (typeof value === 'symbol') return value.description ?? '[symbol]';
  if (typeof value === 'function') return '[function]';
  return '[valor desconocido]';
}

function metadataValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return value.toString();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[valor no serializable]';
  }
}

function quoteIdentifier(engine: StoredDatabaseConnection['engine'], value: string): string {
  if (!value || value.includes('\0'))
    throw new AppError('DATABASE_INVALID_IDENTIFIER', 'El identificador SQL no es válido.');
  return engine === 'mysql'
    ? `\`${value.replaceAll('`', '``')}\``
    : `"${value.replaceAll('"', '""')}"`;
}

function qualify(
  engine: StoredDatabaseConnection['engine'],
  schema: string,
  table: string,
): string {
  if (engine === 'sqlite') return quoteIdentifier(engine, table);
  return `${quoteIdentifier(engine, schema)}.${quoteIdentifier(engine, table)}`;
}

function placeholder(engine: StoredDatabaseConnection['engine'], index: number): string {
  return engine === 'postgresql' ? `$${index}` : '?';
}

function placeholders(engine: StoredDatabaseConnection['engine'], count: number): string {
  return Array.from({ length: count }, (_, index) => placeholder(engine, index + 1)).join(', ');
}

function whereClause(
  engine: StoredDatabaseConnection['engine'],
  entries: ReadonlyArray<readonly [string, DatabaseValue]>,
  offset: number,
): string {
  let parameterIndex = offset;
  return entries
    .map(([name, value]) => {
      if (value === null) return `${quoteIdentifier(engine, name)} IS NULL`;
      parameterIndex += 1;
      return `${quoteIdentifier(engine, name)}=${placeholder(engine, parameterIndex)}`;
    })
    .join(' AND ');
}

async function begin(session: Session): Promise<void> {
  if (session.engine === 'mysql') await session.client.beginTransaction();
  else if (session.engine === 'postgresql') await session.client.query('BEGIN');
  else session.client.exec('BEGIN');
}

async function commit(session: Session): Promise<void> {
  if (session.engine === 'mysql') await session.client.commit();
  else if (session.engine === 'postgresql') await session.client.query('COMMIT');
  else session.client.exec('COMMIT');
}

async function rollback(session: Session): Promise<void> {
  if (session.engine === 'mysql') await session.client.rollback();
  else if (session.engine === 'postgresql') await session.client.query('ROLLBACK');
  else session.client.exec('ROLLBACK');
}

async function closeSession(session: Session): Promise<void> {
  try {
    if (session.engine === 'mysql') await session.client.end();
    else if (session.engine === 'postgresql') await session.client.end();
    else session.client.close();
  } catch {
    // A disconnected server must not prevent Forge from closing a workspace or exiting.
  }
}

function mapDatabaseError(
  error: unknown,
  profile: Pick<StoredDatabaseConnection, 'engine' | 'host' | 'port' | 'database' | 'name'>,
): AppError {
  if (error instanceof AppError) return error;
  const candidate = error as { code?: string; errno?: number; message?: string };
  const code = candidate.code ?? 'DATABASE_ERROR';
  const connectionDetails = {
    connection: profile.name,
    engine: profile.engine,
    host: profile.engine === 'sqlite' ? 'workspace' : profile.host,
    port:
      profile.port ??
      (profile.engine === 'mysql' ? 3306 : profile.engine === 'postgresql' ? 5432 : 0),
    database: profile.database,
  };
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) {
    return new AppError(
      'DATABASE_CONNECTION_UNAVAILABLE',
      'No fue posible alcanzar el servidor de base de datos.',
      ['Verifique host, puerto, red, firewall y disponibilidad del servicio.'],
      connectionDetails,
    );
  }
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return new AppError(
      'DATABASE_HOST_NOT_FOUND',
      'No fue posible resolver el host configurado.',
      ['Revise el nombre del host y la conexión de red.'],
      connectionDetails,
    );
  }
  if (['ER_ACCESS_DENIED_ERROR', '28P01', '28000'].includes(code)) {
    return new AppError(
      'DATABASE_AUTHENTICATION_FAILED',
      'El servidor rechazó el usuario o la contraseña.',
      ['Revise las credenciales guardadas y los permisos de la cuenta.'],
      connectionDetails,
    );
  }
  if (code === '3D000' || code === 'ER_BAD_DB_ERROR') {
    return new AppError(
      'DATABASE_NOT_FOUND',
      'La base de datos configurada no existe o no es accesible.',
      ['Revise el nombre de la base y los permisos del usuario.'],
      connectionDetails,
    );
  }
  if (String(candidate.message).includes('SQLITE_CANTOPEN')) {
    return new AppError(
      'DATABASE_SQLITE_UNAVAILABLE',
      'No fue posible abrir la base SQLite dentro del workspace.',
      ['Revise la ruta relativa y los permisos del archivo o carpeta.'],
      connectionDetails,
    );
  }
  const safeMessage = sanitizeDriverMessage(
    candidate.message ?? 'El motor rechazó la operación SQL.',
  );
  return new AppError(
    `DATABASE_${String(code)
      .replace(/[^A-Z0-9_]/gi, '_')
      .toUpperCase()}`,
    safeMessage,
    ['Revise la sentencia, la estructura actual y los permisos del usuario.'],
    connectionDetails,
  );
}

function sanitizeDriverMessage(message: string): string {
  return message
    .replace(/(password|passwd|token|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[redactado]')
    .replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s]+/gi, '[url de conexión redactada]')
    .slice(0, 600);
}

function parseJsonImport(content: string): { columns: string[]; rows: DatabaseValue[][] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new AppError('DATABASE_IMPORT_INVALID_JSON', 'El archivo JSON no es válido.');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
  ) {
    throw new AppError(
      'DATABASE_IMPORT_INVALID_JSON',
      'El JSON debe contener un arreglo de objetos.',
    );
  }
  const objects = parsed as Array<Record<string, unknown>>;
  const columns = [...new Set(objects.flatMap((item) => Object.keys(item)))];
  if (columns.length === 0)
    throw new AppError('DATABASE_IMPORT_EMPTY', 'El archivo no contiene columnas.');
  return {
    columns,
    rows: objects.map((item) => columns.map((column) => normalizeValue(item[column]))),
  };
}

function parseCsvImport(content: string): { columns: string[]; rows: DatabaseValue[][] } {
  const records: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, ''));
      records.push(row);
      row = [];
      value = '';
    } else value += character;
  }
  if (quoted)
    throw new AppError('DATABASE_IMPORT_INVALID_CSV', 'El CSV contiene una comilla sin cerrar.');
  if (value || row.length > 0) {
    row.push(value.replace(/\r$/, ''));
    records.push(row);
  }
  const columns = records.shift()?.map((column) => column.trim()) ?? [];
  if (columns.length === 0 || columns.some((column) => !column)) {
    throw new AppError(
      'DATABASE_IMPORT_INVALID_CSV',
      'La primera fila debe contener encabezados válidos.',
    );
  }
  if (new Set(columns).size !== columns.length) {
    throw new AppError('DATABASE_IMPORT_INVALID_CSV', 'Los encabezados CSV no pueden repetirse.');
  }
  const rows = records
    .filter((record) => record.some((cell) => cell !== ''))
    .map((record) => {
      if (record.length !== columns.length) {
        throw new AppError(
          'DATABASE_IMPORT_INVALID_CSV',
          'Todas las filas deben tener el mismo número de columnas.',
        );
      }
      return record.map((cell) => (cell === '' ? null : cell));
    });
  return { columns, rows };
}

function toJson(columns: string[], rows: DatabaseValue[][]): string {
  return `${JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(columns.map((column, index) => [column, row[index] ?? null])),
    ),
    null,
    2,
  )}\n`;
}

function toCsv(columns: string[], rows: DatabaseValue[][]): string {
  const escape = (value: DatabaseValue | string): string => {
    const text = value === null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [
    columns.map(escape).join(','),
    ...rows.map((row) => row.map((value) => escape(value)).join(',')),
  ].join('\r\n');
}
