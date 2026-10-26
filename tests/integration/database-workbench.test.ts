import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/core/database';
import {
  DatabaseConnectionRepository,
  DatabaseHistoryRepository,
} from '../../src/main/core/database-repositories';
import { DatabaseWorkbenchService } from '../../src/main/core/database-workbench';
import { WorkspaceRepository } from '../../src/main/core/repositories';
import { EncryptedSecretStore } from '../../src/main/core/secrets';
import type { Workspace } from '../../src/shared/contracts';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forge-database-workspace-'));
  const data = await mkdtemp(join(tmpdir(), 'forge-database-data-'));
  created.push(root, data);
  await mkdir(join(root, 'data'));
  const metadata = openDatabase(join(data, 'forge.db'));
  const workspaces = new WorkspaceRepository(metadata);
  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: crypto.randomUUID(),
    name: 'database-test',
    rootPath: root,
    environment: 'LOCAL',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
  workspaces.create(workspace);
  const connections = new DatabaseConnectionRepository(metadata);
  const history = new DatabaseHistoryRepository(metadata);
  const secrets = new EncryptedSecretStore(metadata, {
    available: () => Promise.resolve(true),
    encrypt: (value) => Promise.resolve(Buffer.from([...value].reverse().join(''), 'utf8')),
    decrypt: (value) =>
      Promise.resolve({
        value: [...value.toString('utf8')].reverse().join(''),
        shouldReEncrypt: false,
      }),
  });
  const service = new DatabaseWorkbenchService(workspaces, connections, history, secrets);
  return { root, metadata, workspace, connections, secrets, service };
}

describe('DatabaseWorkbenchService', () => {
  it('persists encrypted credentials without returning their value', async () => {
    const { metadata, workspace, secrets, service } = await fixture();
    try {
      const profile = await service.saveConnection(
        workspace.id,
        null,
        {
          name: 'Local MySQL',
          engine: 'mysql',
          environment: 'DEVELOPMENT',
          host: 'localhost',
          port: 3306,
          database: 'forge',
          username: 'forge_user',
          sslMode: 'disabled',
          sqlitePath: '',
        },
        'not-a-real-password',
      );
      expect(profile.hasPassword).toBe(true);
      expect(JSON.stringify(profile)).not.toContain('not-a-real-password');
      const row = metadata
        .prepare('SELECT secret_ref FROM database_connections WHERE id=?')
        .get(profile.id) as { secret_ref: string };
      expect(await secrets.get(row.secret_ref)).toBe('not-a-real-password');
      const encrypted = metadata
        .prepare('SELECT encrypted_value FROM secret_values WHERE ref=?')
        .get(row.secret_ref) as { encrypted_value: Buffer };
      expect(encrypted.encrypted_value.toString('utf8')).not.toContain('not-a-real-password');
    } finally {
      await service.dispose();
      metadata.close();
    }
  });

  it('uses a real SQLite database for schema, queries, editing, history and import/export', async () => {
    const { root, metadata, workspace, service } = await fixture();
    try {
      const profile = await service.saveConnection(workspace.id, null, {
        name: 'SQLite del proyecto',
        engine: 'sqlite',
        environment: 'LOCAL',
        host: '',
        port: null,
        database: '',
        username: '',
        sslMode: 'disabled',
        sqlitePath: 'data/app.sqlite',
      });
      expect((await service.connect(workspace.id, profile.id)).connected).toBe(true);
      await service.query(
        workspace.id,
        profile.id,
        'CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)',
        false,
      );
      await service.query(
        workspace.id,
        profile.id,
        "INSERT INTO customers(name, active) VALUES ('Ada', 1), ('Linus', 0)",
        false,
      );

      const catalog = await service.catalog(workspace.id, profile.id);
      expect(catalog.objects).toContainEqual({ schema: 'main', name: 'customers', type: 'table' });
      const structure = await service.structure(workspace.id, profile.id, 'main', 'customers');
      expect(structure.columns.find((column) => column.name === 'id')?.primaryKey).toBe(true);
      expect(structure.columns.find((column) => column.name === 'id')?.autoIncrement).toBe(true);
      let data = await service.tableData(workspace.id, profile.id, 'main', 'customers', 0, 200);
      expect(data.result.rows).toHaveLength(2);

      await service.mutateRow(
        workspace.id,
        profile.id,
        'main',
        'customers',
        { kind: 'insert', values: { name: 'Barbara', active: false } },
        false,
      );

      await service.mutateRow(
        workspace.id,
        profile.id,
        'main',
        'customers',
        { kind: 'update', values: { name: 'Ada Lovelace' }, key: { id: 1 } },
        false,
      );
      await expect(
        service.mutateRow(
          workspace.id,
          profile.id,
          'main',
          'customers',
          { kind: 'delete', key: { id: 2 } },
          false,
        ),
      ).rejects.toMatchObject({ code: 'DATABASE_CONFIRMATION_REQUIRED' });
      await service.mutateRow(
        workspace.id,
        profile.id,
        'main',
        'customers',
        { kind: 'delete', key: { id: 2 } },
        true,
      );
      data = await service.tableData(workspace.id, profile.id, 'main', 'customers', 0, 200);
      expect(data.result.rows).toContainEqual([1, 'Ada Lovelace', 1]);
      expect(data.result.rows).toContainEqual([3, 'Barbara', 0]);

      await service.query(
        workspace.id,
        profile.id,
        "CREATE TABLE defaults_only(id INTEGER PRIMARY KEY, label TEXT NOT NULL DEFAULT 'nuevo')",
        false,
      );
      await service.mutateRow(
        workspace.id,
        profile.id,
        'main',
        'defaults_only',
        { kind: 'insert', values: {} },
        false,
      );
      expect(
        (await service.tableData(workspace.id, profile.id, 'main', 'defaults_only', 0, 10)).result
          .rows,
      ).toContainEqual([1, 'nuevo']);

      const importPath = join(root, 'customers.csv');
      await writeFile(importPath, 'name,active\nGrace,1\nMargaret,1\n', 'utf8');
      const preview = await service.previewImport(workspace.id, importPath);
      expect(preview.totalRows).toBe(2);
      const imported = await service.applyImport(
        workspace.id,
        profile.id,
        preview.importId,
        'main',
        'customers',
        false,
      );
      expect(imported.affectedRows).toBe(2);

      const bounded = await service.query(
        workspace.id,
        profile.id,
        `WITH RECURSIVE numbers(value) AS (
           SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 1500
         ) SELECT value FROM numbers`,
        false,
      );
      expect(bounded.rows).toHaveLength(1000);
      expect(bounded.truncated).toBe(true);
      expect(
        await service.query(workspace.id, profile.id, "SELECT ';' AS delimiter;", false),
      ).toMatchObject({ rows: [[';']] });
      await expect(
        service.query(workspace.id, profile.id, 'SELECT 1; SELECT 2;', false),
      ).rejects.toMatchObject({ code: 'DATABASE_MULTIPLE_STATEMENTS' });

      const invalidImportPath = join(root, 'customers-invalid.csv');
      await writeFile(invalidImportPath, 'id,name,active\n50,Primera,1\n50,Duplicada,1\n', 'utf8');
      const invalidPreview = await service.previewImport(workspace.id, invalidImportPath);
      await expect(
        service.applyImport(
          workspace.id,
          profile.id,
          invalidPreview.importId,
          'main',
          'customers',
          false,
        ),
      ).rejects.toMatchObject({ code: 'DATABASE_SQLITE_CONSTRAINT_PRIMARYKEY' });

      const finalData = await service.tableData(
        workspace.id,
        profile.id,
        'main',
        'customers',
        0,
        200,
      );
      expect(finalData.result.rows.some((row) => row[0] === 50)).toBe(false);
      const exportPath = join(root, 'customers.json');
      await service.exportResult(
        workspace.id,
        profile.id,
        'json',
        finalData.result.columns.map((column) => column.name),
        finalData.result.rows,
        exportPath,
      );
      const exported = await import('node:fs/promises').then(({ readFile }) =>
        readFile(exportPath, 'utf8'),
      );
      expect(exported).toContain('Ada Lovelace');
      expect(service.history(workspace.id, 100).length).toBeGreaterThanOrEqual(5);
    } finally {
      await service.dispose();
      metadata.close();
    }
  });

  it('confines SQLite paths and reinforces production writes', async () => {
    const { metadata, workspace, service } = await fixture();
    try {
      const outside = await service.saveConnection(workspace.id, null, {
        name: 'Fuera',
        engine: 'sqlite',
        environment: 'LOCAL',
        host: '',
        port: null,
        database: '',
        username: '',
        sslMode: 'disabled',
        sqlitePath: '../outside.sqlite',
      });
      await expect(service.connect(workspace.id, outside.id)).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });

      const production = await service.saveConnection(workspace.id, null, {
        name: 'Producción local',
        engine: 'sqlite',
        environment: 'PRODUCTION',
        host: '',
        port: null,
        database: '',
        username: '',
        sslMode: 'disabled',
        sqlitePath: 'data/production.sqlite',
      });
      await service.connect(workspace.id, production.id);
      await expect(
        service.query(workspace.id, production.id, 'CREATE TABLE audit(id INTEGER)', false),
      ).rejects.toMatchObject({ code: 'DATABASE_PRODUCTION_CONFIRMATION_REQUIRED' });
      await service.query(workspace.id, production.id, 'CREATE TABLE audit(id INTEGER)', true);
      expect((await service.catalog(workspace.id, production.id)).objects).toHaveLength(1);
    } finally {
      await service.dispose();
      metadata.close();
    }
  });
});
