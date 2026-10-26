import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/core/database';
import { EventBus } from '../../src/main/core/events';
import { Logger } from '../../src/main/core/logger';
import { WorkspaceRepository } from '../../src/main/core/repositories';
import { TerminalManager } from '../../src/main/core/terminal';
import { WorkspaceService } from '../../src/main/core/workspaces';

const created: string[] = [];
afterEach(async () =>
  Promise.all(
    created
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  ),
);

describe('TerminalManager', () => {
  it('starts in the workspace and streams an interactive command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-terminal-'));
    const data = await mkdtemp(join(tmpdir(), 'forge-terminal-data-'));
    created.push(root, data);
    const db = openDatabase(join(data, 'forge.db'));
    const repository = new WorkspaceRepository(db);
    const workspace = await new WorkspaceService(
      repository,
      new EventBus(new Logger(join(data, 'log'))),
    ).openPath(root, crypto.randomUUID());
    let output = '';
    let resolveOutput: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      resolveOutput = resolve;
    });
    const manager = new TerminalManager(
      repository,
      ({ data: chunk }) => {
        output += chunk;
        if (output.includes('FORGE_TERMINAL_OK')) resolveOutput?.();
      },
      () => undefined,
    );
    const session = manager.create(workspace.id, 80, 24);
    manager.write(session.id, 'Write-Output "FORGE_TERMINAL_OK"\r');
    await Promise.race([
      received,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Terminal output timeout')), 20_000),
      ),
    ]);
    expect(output).toContain('FORGE_TERMINAL_OK');
    manager.dispose();
    db.close();
  }, 12_000);
});
