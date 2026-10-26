import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { CommandBus } from '../../src/main/core/commands';
import { Logger } from '../../src/main/core/logger';

describe('CommandBus', () => {
  it('rejects unknown commands before reaching the handler', async () => {
    const handler = vi.fn();
    const bus = new CommandBus(handler, new Logger(join(tmpdir(), 'forge-command-test.log')));
    const result = await bus.execute({ name: 'shell.execute', input: { command: 'bad' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_COMMAND');
    expect(handler).not.toHaveBeenCalled();
  });

  it('enforces list limits', async () => {
    const bus = new CommandBus(vi.fn(), new Logger(join(tmpdir(), 'forge-command-test.log')));
    const result = await bus.execute({ name: 'workspace.listRecent', input: { limit: 5000 } });
    expect(result.ok).toBe(false);
  });

  it('does not expose a generic Git command and validates commit identifiers', async () => {
    const handler = vi.fn();
    const bus = new CommandBus(handler, new Logger(join(tmpdir(), 'forge-command-test.log')));
    const generic = await bus.execute({
      name: 'git.exec',
      input: { workspaceId: crypto.randomUUID(), args: ['status'] },
    });
    const injectedRevision = await bus.execute({
      name: 'git.show',
      input: { workspaceId: crypto.randomUUID(), repositoryPath: '', commit: '--help' },
    });
    expect(generic.ok).toBe(false);
    expect(injectedRevision.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('validates the extended Git and recommendation IPC contracts', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const bus = new CommandBus(handler, new Logger(join(tmpdir(), 'forge-command-test.log')));
    const workspaceId = crypto.randomUUID();
    const initialized = await bus.execute({
      name: 'git.init',
      input: { workspaceId, repositoryPath: '', initialBranch: 'main' },
    });
    const resolvedDeletion = await bus.execute({
      name: 'git.resolveConflict',
      input: {
        workspaceId,
        repositoryPath: '',
        path: 'deleted.txt',
        content: null,
        expectedVersion: 'a'.repeat(64),
      },
    });
    const recommendations = await bus.execute({
      name: 'recommendations.list',
      input: { workspaceId, source: 'git.advisor' },
    });
    const configuredIdentity = await bus.execute({
      name: 'git.configureIdentity',
      input: {
        workspaceId,
        repositoryPath: '',
        name: 'Forge User',
        email: 'forge@example.test',
      },
    });
    const invalidIdentity = await bus.execute({
      name: 'git.configureIdentity',
      input: {
        workspaceId,
        repositoryPath: '',
        name: 'Forge User',
        email: 'not-an-email',
      },
    });
    const syncAnalysis = await bus.execute({
      name: 'git.analyzeSync',
      input: { workspaceId, repositoryPath: '' },
    });
    const mergeIntegration = await bus.execute({
      name: 'git.integrateSync',
      input: { workspaceId, repositoryPath: '', strategy: 'merge', confirmed: true },
    });
    const invalidIntegration = await bus.execute({
      name: 'git.integrateSync',
      input: { workspaceId, repositoryPath: '', strategy: 'squash', confirmed: true },
    });

    expect(initialized.ok).toBe(true);
    expect(resolvedDeletion.ok).toBe(true);
    expect(recommendations.ok).toBe(true);
    expect(configuredIdentity.ok).toBe(true);
    expect(invalidIdentity.ok).toBe(false);
    expect(syncAnalysis.ok).toBe(true);
    expect(mergeIntegration.ok).toBe(true);
    expect(invalidIntegration.ok).toBe(false);
    expect(handler).toHaveBeenCalledTimes(6);
  });
});
