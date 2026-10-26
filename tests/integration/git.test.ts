import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/core/database';
import { EventBus } from '../../src/main/core/events';
import { GitService } from '../../src/main/core/git';
import { Logger } from '../../src/main/core/logger';
import { WorkspaceRepository } from '../../src/main/core/repositories';
import { WorkspaceService } from '../../src/main/core/workspaces';

const execute = promisify(execFile);
const created: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return result.stdout;
}

async function harness(initialized = true) {
  const root = await mkdtemp(join(tmpdir(), 'forge-git-'));
  const data = await mkdtemp(join(tmpdir(), 'forge-git-data-'));
  created.push(root, data);
  if (initialized) {
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.name', 'Forge Test');
    await git(root, 'config', 'user.email', 'forge@example.test');
    await git(root, 'config', 'core.autocrlf', 'false');
  }
  const db = openDatabase(join(data, 'forge.db'));
  databases.push(db);
  const repository = new WorkspaceRepository(db);
  const workspace = await new WorkspaceService(
    repository,
    new EventBus(new Logger(join(data, 'forge.log'))),
  ).openPath(root, crypto.randomUUID());
  const trash = join(data, 'trash');
  await mkdir(trash);
  const service = new GitService(repository, async (path) =>
    rename(path, join(trash, basename(path))),
  );
  return { root, data, workspace, service, trash };
}

async function divergentHarness(initialFiles: Record<string, string>) {
  const context = await harness();
  const remote = await mkdtemp(join(tmpdir(), 'forge-git-diverged-remote-'));
  const peer = await mkdtemp(join(tmpdir(), 'forge-git-diverged-peer-'));
  created.push(remote, peer);
  await git(remote, 'init', '--bare', '--initial-branch=main');
  for (const [path, content] of Object.entries(initialFiles)) {
    await writeFile(join(context.root, path), content, 'utf8');
  }
  await git(context.root, 'add', '.');
  await git(context.root, 'commit', '-m', 'base compartida');
  await git(context.root, 'remote', 'add', 'origin', remote);
  await context.service.push(context.workspace.id, '');
  await rm(peer, { recursive: true, force: true });
  await git(tmpdir(), 'clone', remote, peer);
  await git(peer, 'config', 'user.name', 'Remote Peer');
  await git(peer, 'config', 'user.email', 'remote-peer@example.test');
  await git(peer, 'config', 'core.autocrlf', 'false');
  return { ...context, remote, peer };
}

async function commitFile(cwd: string, path: string, content: string, message: string) {
  await writeFile(join(cwd, path), content, 'utf8');
  await git(cwd, 'add', path);
  await git(cwd, 'commit', '-m', message);
}

describe('GitService', () => {
  it('initializes a repository with an explicit branch and reports the equivalent command', async () => {
    const { workspace, service } = await harness(false);
    expect(await service.repositories(workspace.id)).toEqual([]);

    const result = await service.initialize(workspace.id, '', 'trunk');

    expect(result.command).toBe('git init -b trunk');
    expect(await service.repositories(workspace.id)).toEqual([
      expect.objectContaining({ path: '', currentBranch: 'trunk', head: null }),
    ]);
    expect(await service.githubInfo(workspace.id, '')).toBeNull();
    expect((await service.status(workspace.id, '')).syncState).toBe('no-remote');
    await expect(service.initialize(workspace.id, '', 'main')).rejects.toMatchObject({
      code: 'GIT_ALREADY_INITIALIZED',
    });
  });

  it('detects repositories and sanitizes GitHub remote information', async () => {
    const { root, workspace, service } = await harness();
    await git(
      root,
      'remote',
      'add',
      'origin',
      'https://secret-token@github.com/forge-tests/sample.git',
    );
    const repositories = await service.repositories(workspace.id);
    expect(repositories).toHaveLength(1);
    expect(repositories[0]).toMatchObject({
      path: '',
      name: basename(root),
      currentBranch: 'main',
      detached: false,
      github: {
        remote: 'origin',
        owner: 'forge-tests',
        repository: 'sample',
        webUrl: 'https://github.com/forge-tests/sample',
      },
    });
    expect(JSON.stringify(repositories)).not.toContain('secret-token');
  });

  it('detects missing author data, configures it locally and then permits the commit', async () => {
    const { root, workspace, service } = await harness();
    await git(root, 'config', 'user.name', '');
    await git(root, 'config', 'user.email', '');
    await writeFile(join(root, 'initial.txt'), 'ready\n', 'utf8');
    await git(root, 'add', 'initial.txt');

    expect(await service.identity(workspace.id, '')).toMatchObject({
      name: null,
      email: null,
      complete: false,
    });
    await expect(service.commit(workspace.id, '', 'must not exist')).rejects.toMatchObject({
      code: 'GIT_IDENTITY_MISSING',
      safeDetails: { missingName: true, missingEmail: true },
    });

    const configured = await service.configureIdentity(
      workspace.id,
      '',
      'Forge Configured',
      'configured@example.test',
    );
    expect(configured.command).toContain('git config --local user.name');
    expect(await service.identity(workspace.id, '')).toEqual({
      name: 'Forge Configured',
      email: 'configured@example.test',
      complete: true,
    });
    await service.commit(workspace.id, '', 'initial from Forge');
    expect((await service.history(workspace.id, '', 1))[0]?.subject).toBe('initial from Forge');
    await expect(
      service.configureIdentity(workspace.id, '', 'Bad\nName', 'not-an-email'),
    ).rejects.toMatchObject({ code: 'GIT_IDENTITY_INVALID' });
  });

  it('explains that push requires an initial commit before contacting the remote', async () => {
    const { root, workspace, service } = await harness();
    const remote = await mkdtemp(join(tmpdir(), 'forge-git-empty-remote-'));
    created.push(remote);
    await git(remote, 'init', '--bare', '--initial-branch=main');
    await git(root, 'remote', 'add', 'origin', remote);

    await expect(service.push(workspace.id, '')).rejects.toMatchObject({
      code: 'GIT_INITIAL_COMMIT_REQUIRED',
    });
  });

  it('supports status, diff, staging, commits, branches, checkout, merge and history', async () => {
    const { root, workspace, service } = await harness();
    await writeFile(join(root, 'app.ts'), 'export const value = 1;\n', 'utf8');
    await git(root, 'add', 'app.ts');
    await git(root, 'commit', '-m', 'initial');

    await writeFile(join(root, 'app.ts'), 'export const value = 2;\n', 'utf8');
    await writeFile(join(root, 'new.ts'), 'export const added = true;\n', 'utf8');
    let status = await service.status(workspace.id, '');
    expect(status.branch).toBe('main');
    expect(status.head).toMatch(/^[0-9a-f]{40}$/);
    expect(status.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'app.ts', unstaged: true, untracked: false }),
        expect.objectContaining({ path: 'new.ts', unstaged: true, untracked: true }),
      ]),
    );
    expect((await service.diff(workspace.id, '', 'app.ts', false)).content).toContain(
      '+export const value = 2;',
    );
    expect((await service.diff(workspace.id, '', 'new.ts', false)).content).toContain(
      'new file mode',
    );

    await service.stage(workspace.id, '', ['app.ts', 'new.ts']);
    status = await service.status(workspace.id, '');
    expect(status.files.every((file) => file.staged)).toBe(true);
    await service.unstage(workspace.id, '', ['new.ts']);
    expect(
      (await service.status(workspace.id, '')).files.find((file) => file.path === 'new.ts'),
    ).toMatchObject({ untracked: true, staged: false });
    await service.stage(workspace.id, '', ['new.ts']);
    await service.commit(workspace.id, '', 'update files');

    await service.createBranch(workspace.id, '', 'feature/safe');
    await writeFile(join(root, 'feature.txt'), 'feature\n', 'utf8');
    await service.stage(workspace.id, '', ['feature.txt']);
    await service.commit(workspace.id, '', 'feature commit');
    await service.checkout(workspace.id, '', 'main');
    await service.merge(workspace.id, '', 'feature/safe');

    expect(await readFile(join(root, 'feature.txt'), 'utf8')).toBe('feature\n');
    expect((await service.branches(workspace.id, '')).map((branch) => branch.name)).toEqual(
      expect.arrayContaining(['main', 'feature/safe']),
    );
    expect((await service.history(workspace.id, '', 10)).map((commit) => commit.subject)).toEqual(
      expect.arrayContaining(['initial', 'update files', 'feature commit']),
    );
  });

  it('discards tracked edits and sends untracked files to the trash', async () => {
    const { root, workspace, service, trash } = await harness();
    await writeFile(join(root, 'tracked.txt'), 'original\n', 'utf8');
    await git(root, 'add', 'tracked.txt');
    await git(root, 'commit', '-m', 'initial');
    await writeFile(join(root, 'tracked.txt'), 'changed\n', 'utf8');
    await writeFile(join(root, 'untracked.txt'), 'temporary\n', 'utf8');

    await service.discard(workspace.id, '', ['tracked.txt', 'untracked.txt']);

    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('original\n');
    expect(await readFile(join(trash, 'untracked.txt'), 'utf8')).toBe('temporary\n');
  });

  it('pushes and pulls through an explicit local remote without a shell', async () => {
    const { root, workspace, service } = await harness();
    const remote = await mkdtemp(join(tmpdir(), 'forge-git-remote-'));
    const peer = await mkdtemp(join(tmpdir(), 'forge-git-peer-'));
    created.push(remote, peer);
    await git(remote, 'init', '--bare', '--initial-branch=main');
    await writeFile(join(root, 'shared.txt'), 'one\n', 'utf8');
    await git(root, 'add', 'shared.txt');
    await git(root, 'commit', '-m', 'initial');
    await git(root, 'remote', 'add', 'origin', remote);
    const firstPush = await service.push(workspace.id, '');
    expect(firstPush.command).toContain('git push --set-upstream origin main');
    let status = await service.status(workspace.id, '');
    expect(status).toMatchObject({
      upstream: 'origin/main',
      syncState: 'synchronized',
      ahead: 0,
      behind: 0,
      stashCount: 0,
    });
    expect(status.lastCommit?.subject).toBe('initial');
    expect(status.lastRemoteCommit?.subject).toBe('initial');
    expect(status.remotes.map((item) => item.name)).toEqual(['origin']);

    await rm(peer, { recursive: true, force: true });
    await git(tmpdir(), 'clone', remote, peer);
    await git(peer, 'config', 'user.name', 'Peer');
    await git(peer, 'config', 'user.email', 'peer@example.test');
    await writeFile(join(peer, 'shared.txt'), 'two\n', 'utf8');
    await git(peer, 'add', 'shared.txt');
    await git(peer, 'commit', '-m', 'peer update');
    await git(peer, 'push');
    await writeFile(join(root, 'local.txt'), 'local\n', 'utf8');
    await git(root, 'add', 'local.txt');
    await git(root, 'commit', '-m', 'local update');
    await service.fetch(workspace.id, '');
    status = await service.status(workspace.id, '');
    expect(status).toMatchObject({ syncState: 'diverged', ahead: 1, behind: 1 });

    await git(root, 'reset', '--hard', 'origin/main');
    await service.pull(workspace.id, '');

    expect(await readFile(join(root, 'shared.txt'), 'utf8')).toBe('two\n');
  });

  it('analyzes divergent commits on different files, requires explicit cleanup and completes merge plus push', async () => {
    const { root, peer, workspace, service } = await divergentHarness({
      'base.txt': 'base\n',
    });
    await commitFile(root, 'local.txt', 'solo local\n', 'cambio local exclusivo');
    await commitFile(peer, 'remote.txt', 'solo remoto\n', 'cambio remoto exclusivo');
    await git(peer, 'push');

    await service.fetch(workspace.id, '');
    expect(await service.status(workspace.id, '')).toMatchObject({
      syncState: 'diverged',
      ahead: 1,
      behind: 1,
    });
    const analysis = await service.analyzeSync(workspace.id, '');
    expect(analysis).toMatchObject({
      localBranch: 'main',
      remoteBranch: 'origin/main',
      ahead: 1,
      behind: 1,
      workingTreeDirty: false,
      conflictedFiles: [],
      recommendedStrategy: 'merge',
    });
    expect(analysis.localCommits[0]).toMatchObject({
      subject: 'cambio local exclusivo',
      files: [expect.objectContaining({ status: 'A', path: 'local.txt' })],
    });
    expect(analysis.remoteCommits[0]).toMatchObject({
      subject: 'cambio remoto exclusivo',
      files: [expect.objectContaining({ status: 'A', path: 'remote.txt' })],
    });
    expect(analysis.sharedFiles).toEqual([]);
    await expect(service.pull(workspace.id, '')).rejects.toMatchObject({
      code: 'GIT_SYNC_DIVERGED',
    });
    await expect(service.push(workspace.id, '')).rejects.toMatchObject({
      code: 'GIT_REMOTE_CHANGES_PENDING',
    });

    await writeFile(join(root, 'draft.txt'), 'sin confirmar\n', 'utf8');
    expect((await service.analyzeSync(workspace.id, '')).workingTreeDirty).toBe(true);
    await expect(service.integrateSync(workspace.id, '', 'merge')).rejects.toMatchObject({
      code: 'GIT_LOCAL_CHANGES',
    });
    expect((await service.stash(workspace.id, '')).command).toContain('git stash push');
    expect(await service.status(workspace.id, '')).toMatchObject({ dirty: false, stashCount: 1 });

    const integration = await service.integrateSync(workspace.id, '', 'merge');
    expect(integration.command).toContain('git merge --no-edit -- origin/main');
    expect(await service.status(workspace.id, '')).toMatchObject({
      syncState: 'ahead',
      ahead: 2,
      behind: 0,
      conflictCount: 0,
      operation: null,
    });
    await service.push(workspace.id, '');
    expect(await service.status(workspace.id, '')).toMatchObject({
      syncState: 'synchronized',
      ahead: 0,
      behind: 0,
    });
  });

  it('integrates non-overlapping zones of the same file with explicit rebase', async () => {
    const base = Array.from({ length: 12 }, (_, index) => `línea ${index + 1}`).join('\n') + '\n';
    const { root, peer, workspace, service } = await divergentHarness({ 'shared.txt': base });
    const local = base.replace('línea 1', 'línea 1 local');
    const remote = base.replace('línea 12', 'línea 12 remota');
    await commitFile(root, 'shared.txt', local, 'editar inicio local');
    await commitFile(peer, 'shared.txt', remote, 'editar final remoto');
    await git(peer, 'push');
    await service.fetch(workspace.id, '');

    const analysis = await service.analyzeSync(workspace.id, '');
    expect(analysis.sharedFiles).toEqual(['shared.txt']);
    expect(analysis.conflictCount).toBe(0);
    const integration = await service.integrateSync(workspace.id, '', 'rebase');
    expect(integration.command).toBe('git rebase origin/main');
    expect(await readFile(join(root, 'shared.txt'), 'utf8')).toContain('línea 1 local');
    expect(await readFile(join(root, 'shared.txt'), 'utf8')).toContain('línea 12 remota');
    expect(await service.status(workspace.id, '')).toMatchObject({
      syncState: 'ahead',
      ahead: 1,
      behind: 0,
      conflictCount: 0,
    });
    await service.push(workspace.id, '');
    expect(await service.status(workspace.id, '')).toMatchObject({
      syncState: 'synchronized',
      ahead: 0,
      behind: 0,
    });
  });

  it('pauses a divergent merge on a real conflict, resolves it explicitly and verifies final synchronization', async () => {
    const { root, peer, workspace, service } = await divergentHarness({
      'conflict.txt': 'valor base\n',
    });
    await commitFile(root, 'conflict.txt', 'valor local\n', 'decisión local');
    await commitFile(peer, 'conflict.txt', 'valor remoto\n', 'decisión remota');
    await git(peer, 'push');
    await service.fetch(workspace.id, '');

    expect((await service.analyzeSync(workspace.id, '')).sharedFiles).toEqual(['conflict.txt']);
    await expect(service.integrateSync(workspace.id, '', 'merge')).rejects.toMatchObject({
      code: 'GIT_CONFLICT',
    });
    expect(await service.status(workspace.id, '')).toMatchObject({
      syncState: 'conflicted',
      operation: 'merge',
      conflictCount: 1,
    });
    expect(await service.analyzeSync(workspace.id, '')).toMatchObject({
      operation: 'merge',
      conflictCount: 1,
      conflictedFiles: ['conflict.txt'],
    });

    const conflict = await service.conflict(workspace.id, '', 'conflict.txt');
    expect(conflict).toMatchObject({ local: 'valor local\n', remote: 'valor remoto\n' });
    await service.resolveConflict(
      workspace.id,
      '',
      'conflict.txt',
      'valor local\nvalor remoto\n',
      conflict.version,
    );
    expect((await service.status(workspace.id, '')).conflictCount).toBe(0);
    expect((await service.continueIntegration(workspace.id, '')).command).toBe(
      'git commit --no-edit',
    );
    expect(await service.status(workspace.id, '')).toMatchObject({
      syncState: 'ahead',
      operation: null,
      ahead: 2,
      behind: 0,
      conflictCount: 0,
    });
    await service.push(workspace.id, '');
    expect(await service.status(workspace.id, '')).toMatchObject({
      syncState: 'synchronized',
      ahead: 0,
      behind: 0,
      conflictCount: 0,
    });
  });

  it('rejects repository traversal', async () => {
    const { workspace, service } = await harness();
    await expect(service.status(workspace.id, '../outside')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('detects a conflicted merge and can abort it safely', async () => {
    const { root, workspace, service } = await harness();
    await writeFile(join(root, 'conflict.txt'), 'base\n', 'utf8');
    await git(root, 'add', 'conflict.txt');
    await git(root, 'commit', '-m', 'base');
    await service.createBranch(workspace.id, '', 'feature/conflict');
    await writeFile(join(root, 'conflict.txt'), 'feature\n', 'utf8');
    await git(root, 'add', 'conflict.txt');
    await git(root, 'commit', '-m', 'feature');
    await service.checkout(workspace.id, '', 'main');
    await writeFile(join(root, 'conflict.txt'), 'main\n', 'utf8');
    await git(root, 'add', 'conflict.txt');
    await git(root, 'commit', '-m', 'main');

    await expect(service.merge(workspace.id, '', 'feature/conflict')).rejects.toMatchObject({
      code: 'GIT_CONFLICT',
    });
    expect(await service.status(workspace.id, '')).toMatchObject({
      operation: 'merge',
      syncState: 'conflicted',
      conflictCount: 1,
      files: [
        expect.objectContaining({
          path: 'conflict.txt',
          conflicted: true,
          conflictType: 'both-modified',
        }),
      ],
    });
    const conflict = await service.conflict(workspace.id, '', 'conflict.txt');
    expect(conflict).toMatchObject({
      local: 'main\n',
      remote: 'feature\n',
      hasMarkers: true,
    });
    expect(conflict.version).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      service.resolveConflict(workspace.id, '', 'conflict.txt', conflict.result, conflict.version),
    ).rejects.toMatchObject({ code: 'GIT_CONFLICT_MARKERS_REMAIN' });
    const resolution = await service.resolveConflict(
      workspace.id,
      '',
      'conflict.txt',
      'main\nfeature\n',
      conflict.version,
    );
    expect(resolution.command).toBe('git add -- conflict.txt');
    expect((await service.status(workspace.id, '')).conflictCount).toBe(0);
    expect(await readFile(join(root, 'conflict.txt'), 'utf8')).toBe('main\nfeature\n');
    await service.abortMerge(workspace.id, '');
    expect((await service.status(workspace.id, '')).operation).toBeNull();
    expect(await readFile(join(root, 'conflict.txt'), 'utf8')).toBe('main\n');
  });

  it('ignores process-level repository overrides', async () => {
    const { root, workspace, service } = await harness();
    await writeFile(join(root, 'safe.txt'), 'safe\n', 'utf8');
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(root, 'does-not-exist');
    try {
      expect((await service.status(workspace.id, '')).branch).toBe('main');
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it('detects configurable sensitive filenames and honors gitignore awareness', async () => {
    const { root, workspace, service } = await harness();
    await mkdir(join(root, 'secrets'));
    await writeFile(join(root, '.gitignore'), '.env\n', 'utf8');
    await writeFile(join(root, '.env'), 'PASSWORD=not-a-real-secret\n', 'utf8');
    await writeFile(join(root, 'secrets', 'deploy.pem'), 'test key\n', 'utf8');
    await git(root, 'add', '.gitignore');
    await git(root, 'add', '-f', '.env');

    const files = (await service.status(workspace.id, '')).files;
    const sensitive = await service.sensitiveFiles(workspace.id, '', files, ['.env', '**/*.pem']);

    expect(sensitive).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.env',
          pattern: '.env',
          staged: true,
          ignoredByGit: true,
        }),
        expect.objectContaining({
          path: 'secrets/deploy.pem',
          pattern: '**/*.pem',
          untracked: true,
          ignoredByGit: false,
        }),
      ]),
    );
  });

  it('validates remote URLs, rejects embedded credentials and sanitizes display values', async () => {
    const { workspace, service } = await harness();
    await expect(
      service.setRemote(workspace.id, '', 'origin', 'https://token@github.com/acme/repo.git'),
    ).rejects.toMatchObject({ code: 'GIT_REMOTE_CREDENTIALS_BLOCKED' });
    await expect(
      service.setRemote(workspace.id, '', 'origin', 'ext::unsafe-helper'),
    ).rejects.toMatchObject({ code: 'GIT_REMOTE_URL_INVALID' });

    const result = await service.setRemote(
      workspace.id,
      '',
      'origin',
      'https://github.com/acme/repo.git',
    );
    expect(result.command).toBe('git remote add origin https://github.com/acme/repo.git');
    const remotes = await service.remotes(workspace.id, '');
    expect(remotes[0]).toMatchObject({
      name: 'origin',
      fetchUrl: 'https://github.com/acme/repo.git',
    });
    expect(remotes[0]?.github).toMatchObject({ owner: 'acme', repository: 'repo' });
  });

  it('blocks external remote-helper protocols', async () => {
    const { root, workspace, service } = await harness();
    await git(root, 'remote', 'add', 'origin', 'ext::forge-should-never-execute');
    await expect(service.fetch(workspace.id, '')).rejects.toMatchObject({
      code: 'GIT_COMMAND_FAILED',
    });
  });

  it('reports an unavailable remote without requiring GitHub', async () => {
    const { root, workspace, service } = await harness();
    await service.setRemote(workspace.id, '', 'origin', join(root, 'missing-remote.git'));
    await expect(service.fetch(workspace.id, '')).rejects.toMatchObject({
      code: 'GIT_REMOTE_UNAVAILABLE',
    });
    expect(await service.githubInfo(workspace.id, '')).toBeNull();
  });
});
