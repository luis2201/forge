import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/core/database';
import { EventBus } from '../../src/main/core/events';
import { Logger } from '../../src/main/core/logger';
import { WorkspaceRepository } from '../../src/main/core/repositories';
import { SearchService } from '../../src/main/core/search';
import { WorkspaceService } from '../../src/main/core/workspaces';

const created: string[] = [];
afterEach(async () =>
  Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

describe('SearchService', () => {
  it('searches text with line metadata and ignores dependency directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-search-'));
    const data = await mkdtemp(join(tmpdir(), 'forge-search-data-'));
    created.push(root, data);
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'src', 'main.ts'), 'first\nForge Needle\nlast', 'utf8');
    await writeFile(join(root, 'node_modules', 'ignored.js'), 'Forge Needle', 'utf8');
    const db = openDatabase(join(data, 'forge.db'));
    const repository = new WorkspaceRepository(db);
    const workspace = await new WorkspaceService(
      repository,
      new EventBus(new Logger(join(data, 'log'))),
    ).openPath(root, crypto.randomUUID());
    const response = await new SearchService(repository).text(workspace.id, 'forge needle', false);
    expect(response.results).toEqual([
      { path: 'src/main.ts', line: 2, column: 1, preview: 'Forge Needle' },
    ]);
    expect(response.filesScanned).toBe(1);
    db.close();
  });
});
