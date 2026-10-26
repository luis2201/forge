import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/core/database';
import { EventBus } from '../../src/main/core/events';
import { Logger } from '../../src/main/core/logger';
import { WorkspaceRepository } from '../../src/main/core/repositories';
import { WorkspaceService } from '../../src/main/core/workspaces';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('WorkspaceService', () => {
  it('creates, reopens, lists, configures and closes a workspace without altering its folder', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'forge-workspace-'));
    created.push(folder);
    const data = await mkdtemp(join(tmpdir(), 'forge-data-'));
    created.push(data);
    const db = openDatabase(join(data, 'forge.db'));
    const logger = new Logger(join(data, 'forge.log'));
    const events = new EventBus(logger);
    const seen: string[] = [];
    events.subscribe('workspace.opened', () => {
      seen.push('opened');
    });
    events.subscribe('workspace.closed', () => {
      seen.push('closed');
    });
    const service = new WorkspaceService(new WorkspaceRepository(db), events);

    const first = await service.openPath(folder, crypto.randomUUID());
    const second = await service.openPath(folder, crypto.randomUUID());
    expect(second.id).toBe(first.id);
    expect(service.listRecent(12)).toHaveLength(1);
    expect(
      await service.updateSettings(first.id, { environment: 'PRODUCTION' }, crypto.randomUUID()),
    ).toEqual({ environment: 'PRODUCTION' });
    db.prepare('UPDATE workspace_settings SET settings_json=? WHERE workspace_id=?').run(
      '{corrupt',
      first.id,
    );
    expect(service.listRecent(12)[0]?.environment).toBe('LOCAL');
    await service.close(first.id, crypto.randomUUID());
    expect(seen).toEqual(['opened', 'opened', 'closed']);
    db.close();
  });
});
