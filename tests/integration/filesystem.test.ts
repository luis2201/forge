import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/core/database';
import { EventBus } from '../../src/main/core/events';
import {
  FileSystemService,
  normalizeRelativePath,
  validateFileName,
} from '../../src/main/core/filesystem';
import { Logger } from '../../src/main/core/logger';
import { WorkspaceRepository } from '../../src/main/core/repositories';
import { WorkspaceService } from '../../src/main/core/workspaces';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'forge-files-'));
  const data = await mkdtemp(join(tmpdir(), 'forge-files-data-'));
  created.push(root, data);
  const db = openDatabase(join(data, 'forge.db'));
  const repository = new WorkspaceRepository(db);
  const workspace = await new WorkspaceService(
    repository,
    new EventBus(new Logger(join(data, 'forge.log'))),
  ).openPath(root, crypto.randomUUID());
  const trash = join(data, 'trash');
  await mkdir(trash);
  const files = new FileSystemService(repository, async (path) =>
    rename(path, join(trash, basename(path))),
  );
  return { root, data, db, workspace, files, trash };
}

describe('FileSystemService', () => {
  it('creates, lists, reads, saves, renames and trashes files', async () => {
    const { db, workspace, files, trash } = await harness();
    await files.createDirectory(workspace.id, 'src');
    const createdFile = await files.createFile(workspace.id, 'src/index.ts');
    expect((await files.list(workspace.id, 'src')).map((item) => item.name)).toEqual(['index.ts']);
    await files.write(
      workspace.id,
      'src/index.ts',
      'export const value = 1;\n',
      createdFile.version,
    );
    const document = await files.read(workspace.id, 'src/index.ts');
    expect(document.content).toBe('export const value = 1;\n');
    const renamed = await files.rename(workspace.id, 'src/index.ts', 'main.ts');
    expect(renamed).toBe('src/main.ts');
    await files.delete(workspace.id, 'src/main.ts');
    expect(await readFile(join(trash, 'main.ts'), 'utf8')).toContain('value = 1');
    db.close();
  });

  it('detects an external write instead of silently overwriting it', async () => {
    const { root, db, workspace, files } = await harness();
    await writeFile(join(root, 'notes.txt'), 'initial', 'utf8');
    const document = await files.read(workspace.id, 'notes.txt');
    await writeFile(join(root, 'notes.txt'), 'changed', 'utf8');
    await expect(
      files.write(workspace.id, 'notes.txt', 'local', document.version),
    ).rejects.toMatchObject({ code: 'FILE_MODIFIED_EXTERNALLY' });
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('changed');
    db.close();
  });

  it('rejects traversal, absolute paths, protected root operations and invalid Windows names', async () => {
    const { db, workspace, files } = await harness();
    await expect(files.read(workspace.id, '../secret.txt')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    expect(() => normalizeRelativePath('C:\\Windows\\system.ini')).toThrowError(/no es válida/);
    expect(() => validateFileName('CON')).toThrowError(/no es válido/);
    await expect(files.delete(workspace.id, '')).rejects.toMatchObject({
      code: 'WORKSPACE_ROOT_PROTECTED',
    });
    await expect(files.createFile(workspace.id, '..config')).resolves.toMatchObject({
      path: '..config',
    });
    db.close();
  });

  it('rejects binary and oversized editor files', async () => {
    const { root, db, workspace, files } = await harness();
    await writeFile(join(root, 'binary.bin'), Buffer.from([1, 0, 2]));
    await writeFile(join(root, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 65));
    await expect(files.read(workspace.id, 'binary.bin')).rejects.toMatchObject({
      code: 'BINARY_FILE',
    });
    await expect(files.read(workspace.id, 'large.txt')).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
    db.close();
  });

  it('blocks symlink escapes and trashes the link without touching its target', async () => {
    const { root, db, workspace, files, trash } = await harness();
    const outside = await mkdtemp(join(tmpdir(), 'forge-files-outside-'));
    created.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'outside', 'utf8');
    await symlink(outside, join(root, 'outside-link'), 'junction');

    await expect(files.read(workspace.id, 'outside-link/secret.txt')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
    await files.delete(workspace.id, 'outside-link');

    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
    expect((await lstat(join(trash, 'outside-link'))).isSymbolicLink()).toBe(true);
    db.close();
  });
});
