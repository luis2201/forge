import { execFile, type ExecFileException } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import type {
  GitBranch,
  GitChangedFile,
  GitCommit,
  GitConflictContent,
  GitConflictType,
  GitDiff,
  GitFileStatus,
  GitHubRemote,
  GitIdentity,
  GitIntegrationStrategy,
  GitOperationResult,
  GitRemote,
  GitRepository,
  GitSensitiveFile,
  GitStatus,
  GitSyncAnalysis,
  GitSyncCommit,
  GitSyncState,
} from '../../shared/contracts.js';
import { AppError } from './errors.js';
import type { WorkspaceRepository } from './repositories.js';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'release',
  'coverage',
  '.next',
  '.cache',
]);
const MAX_SCAN_DIRECTORIES = 5_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30_000;
const NETWORK_TIMEOUT = 120_000;
let gitExecutablePromise: Promise<string> | null = null;
let credentialManagerAvailablePromise: Promise<boolean> | null = null;

interface GitCommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function normalizeRelative(value: string, allowRoot = false): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized === '' && allowRoot) return '';
  if (
    normalized === '' ||
    isAbsolute(normalized) ||
    win32.isAbsolute(normalized) ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new AppError('INVALID_PATH', 'La ruta Git solicitada no es válida.');
  }
  return normalized;
}

function ensureInside(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new AppError(
      'PATH_OUTSIDE_WORKSPACE',
      'La operación Git intenta acceder fuera del workspace autorizado.',
    );
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
    : left === right;
}

function sanitizeOutput(value: string): string {
  return value
    .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1')
    .replace(/(oauth2:|x-access-token:)[^@\s]+/gi, '$1[redacted]')
    .trim()
    .slice(0, 20_000);
}

function gitFailure(error: ExecFileException, stderr: string): AppError {
  const message = sanitizeOutput(stderr || error.message);
  if (error.code === 'ENOENT') {
    return new AppError('GIT_NOT_FOUND', 'Git no está instalado o no está disponible en PATH.', [
      'Instale Git for Windows y reinicie Forge.',
    ]);
  }
  if (error.killed || /timed out/i.test(error.message)) {
    return new AppError('GIT_TIMEOUT', 'La operación Git excedió el tiempo permitido.', [
      'Compruebe la conexión y vuelva a intentarlo.',
    ]);
  }
  if (/not a git repository/i.test(message)) {
    return new AppError('GIT_REPOSITORY_NOT_FOUND', 'La carpeta ya no es un repositorio Git.');
  }
  if (/user\.email|user\.name|author identity unknown/i.test(message)) {
    return new AppError('GIT_IDENTITY_MISSING', 'Git no tiene configurados nombre y correo.', [
      'Configure la identidad desde Control de código fuente antes de crear el commit.',
    ]);
  }
  if (/src refspec .* does not match any/i.test(message)) {
    return new AppError(
      'GIT_INITIAL_COMMIT_REQUIRED',
      'La rama todavía no contiene un commit que pueda publicarse.',
      ['Prepare los archivos y cree el commit inicial antes de hacer push.'],
    );
  }
  if (/nothing to commit|no changes added to commit/i.test(message)) {
    return new AppError('GIT_NOTHING_TO_COMMIT', 'No hay cambios preparados para confirmar.');
  }
  if (/would be overwritten|local changes.*overwritten/i.test(message)) {
    return new AppError(
      'GIT_LOCAL_CHANGES',
      'Los cambios locales impiden completar la operación.',
      ['Confirme, descarte o guarde temporalmente los cambios antes de continuar.'],
    );
  }
  if (/conflict|automatic merge failed|needs merge/i.test(message)) {
    return new AppError(
      'GIT_CONFLICT',
      'Git encontró conflictos que requieren resolución manual.',
      ['Resuelva los archivos marcados, prepárelos y confirme el merge.'],
    );
  }
  if (/no upstream|has no upstream branch/i.test(message)) {
    return new AppError('GIT_UPSTREAM_MISSING', 'La rama actual no tiene un upstream configurado.');
  }
  if (/not possible to fast-forward|divergent branches/i.test(message)) {
    return new AppError(
      'GIT_SYNC_DIVERGED',
      'No es posible realizar una actualización directa porque las ramas han divergido.',
      ['Compare e integre ambas historias mediante Merge o Rebase.'],
      { technical: message },
    );
  }
  if (
    /could not resolve host|failed to connect|connection (?:timed out|refused)|does not appear to be a git repository|repository not found/i.test(
      message,
    )
  ) {
    return new AppError('GIT_REMOTE_UNAVAILABLE', 'El remoto Git no está disponible.', [
      'Compruebe la URL, la conexión y los permisos antes de reintentar.',
    ]);
  }
  if (
    /authentication failed|could not read username|terminal prompts disabled|permission denied/i.test(
      message,
    )
  ) {
    return new AppError('GITHUB_AUTH_REQUIRED', 'GitHub requiere autenticación.', [
      'Git Credential Manager abrirá el flujo seguro de autenticación al reintentar.',
      'Forge no almacena ni puede leer el token.',
    ]);
  }
  return new AppError(
    'GIT_COMMAND_FAILED',
    'Git no pudo completar la operación.',
    ['Revise el estado del repositorio e inténtelo nuevamente.'],
    message ? { technical: message } : undefined,
  );
}

async function runGit(
  cwd: string,
  args: string[],
  options: { timeout?: number; acceptedExitCodes?: number[] } = {},
): Promise<GitCommandOutput> {
  const accepted = options.acceptedExitCodes ?? [0];
  const executable = await gitExecutable();
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      executable,
      [
        '--no-pager',
        '-c',
        'color.ui=false',
        '-c',
        'core.quotepath=false',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.file.allow=always',
        '-c',
        'protocol.http.allow=always',
        '-c',
        'protocol.https.allow=always',
        '-c',
        'protocol.ssh.allow=always',
        '-c',
        'protocol.git.allow=always',
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: gitEnvironment(),
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        timeout: options.timeout ?? DEFAULT_TIMEOUT,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolveCommand({ stdout, stderr, exitCode: 0 });
          return;
        }
        const exitCode = typeof error.code === 'number' ? error.code : null;
        if (exitCode !== null && accepted.includes(exitCode)) {
          resolveCommand({ stdout, stderr, exitCode });
          return;
        }
        rejectCommand(
          gitFailure(
            error,
            [stderr, stdout]
              .map((stream) => stream.trim())
              .filter(Boolean)
              .join('\n'),
          ),
        );
      },
    );
  });
}

async function gitExecutable(): Promise<string> {
  gitExecutablePromise ??= resolveGitExecutable();
  return gitExecutablePromise;
}

async function resolveGitExecutable(): Promise<string> {
  const executableName = process.platform === 'win32' ? 'git.exe' : 'git';
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    for (const base of [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : undefined,
    ]) {
      if (!base) continue;
      candidates.push(join(base, 'Git', 'cmd', executableName));
      candidates.push(join(base, 'Git', 'bin', executableName));
    }
  } else {
    candidates.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git');
  }
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const unquoted = entry.replace(/^"|"$/g, '');
    if (isAbsolute(unquoted)) candidates.push(join(unquoted, executableName));
  }
  for (const candidate of [...new Set(candidates)]) {
    const resolved = await realpath(candidate).catch(() => null);
    if (resolved && (await lstat(resolved)).isFile()) return resolved;
  }
  throw new AppError('GIT_NOT_FOUND', 'Git no está instalado o no está disponible en PATH.', [
    'Instale Git for Windows y reinicie Forge.',
  ]);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const unsafeOverrides = new Set([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_EXEC_PATH',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
    'GIT_CONFIG_COUNT',
  ]);
  for (const key of Object.keys(env)) {
    if (unsafeOverrides.has(key.toUpperCase()) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/i.test(key)) {
      delete env[key];
    }
  }
  env.GIT_PAGER = 'cat';
  env.GIT_TERMINAL_PROMPT = '0';
  env.LANG = 'C';
  env.LC_ALL = 'C';
  return env;
}

export class GitService {
  private readonly authorizedRepositories = new Map<
    string,
    { repository: string; gitDirectory: string }
  >();

  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly moveToTrash: (absolutePath: string) => Promise<void>,
  ) {}

  async initialize(
    workspaceId: string,
    repositoryPath: string,
    initialBranch: string,
  ): Promise<GitOperationResult> {
    const root = await this.workspaceRoot(workspaceId);
    const normalized = normalizeRelative(repositoryPath, true);
    const candidate = normalized ? resolve(root, ...normalized.split('/')) : root;
    ensureInside(root, candidate);
    const directory = await realpath(candidate);
    ensureInside(root, directory);
    await runGit(directory, ['check-ref-format', '--branch', initialBranch]);
    if (
      await access(join(directory, '.git'))
        .then(() => true)
        .catch(() => false)
    ) {
      throw new AppError('GIT_ALREADY_INITIALIZED', 'La carpeta ya contiene un repositorio Git.');
    }
    const output = await runGit(directory, ['init', '-b', initialBranch]);
    this.authorizedRepositories.clear();
    await this.authorizeRepository(root, directory);
    return operationOutput(output, ['init', '-b', initialBranch]);
  }

  async repositories(workspaceId: string): Promise<GitRepository[]> {
    const root = await this.workspaceRoot(workspaceId);
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    const found = new Map<string, GitRepository>();
    let scanned = 0;
    while (queue.length > 0 && scanned < MAX_SCAN_DIRECTORIES) {
      const current = queue.shift();
      if (!current) break;
      scanned += 1;
      let entries;
      try {
        entries = await readdir(current.path, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((entry) => entry.name === '.git')) {
        const repository = await this.inspectRepository(root, current.path).catch(() => null);
        if (repository) found.set(repository.path, repository);
      }
      if (current.depth >= 8) continue;
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          IGNORED_DIRECTORIES.has(entry.name.toLocaleLowerCase())
        ) {
          continue;
        }
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      }
    }
    return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  async status(workspaceId: string, repositoryPath: string): Promise<GitStatus> {
    const { repository, gitDirectory } = await this.resolveRepository(workspaceId, repositoryPath);
    const [output, headOutput] = await Promise.all([
      runGit(repository, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']),
      runGit(repository, ['rev-parse', '--verify', 'HEAD'], { acceptedExitCodes: [0, 128] }),
    ]);
    const records = output.stdout.split('\0').filter(Boolean);
    const header = records.shift() ?? '';
    const branchState = parseBranchHeader(header);
    const files: GitFileStatus[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || record.length < 3) continue;
      const code = record.slice(0, 2);
      const path = record.slice(3);
      const renamed = code.includes('R') || code.includes('C');
      const originalPath = renamed ? records[index + 1] : undefined;
      if (renamed) index += 1;
      const conflict = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code);
      const untracked = code === '??';
      files.push({
        path,
        ...(originalPath ? { originalPath } : {}),
        index: code[0] ?? ' ',
        workingTree: code[1] ?? ' ',
        staged: !untracked && (code[0] ?? ' ') !== ' ',
        unstaged: untracked || (code[1] ?? ' ') !== ' ',
        untracked,
        conflicted: conflict,
        conflictType: conflict ? conflictType(code) : null,
      });
    }
    const [remoteHeadOutput, stashOutput, lastCommit, lastRemoteCommit, remotes] =
      await Promise.all([
        branchState.upstream
          ? runGit(repository, ['rev-parse', '--verify', branchState.upstream], {
              acceptedExitCodes: [0, 128],
            })
          : Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
        runGit(repository, ['stash', 'list', '--format=%gd']),
        this.commitAt(repository, 'HEAD'),
        branchState.upstream
          ? this.commitAt(repository, branchState.upstream)
          : Promise.resolve(null),
        this.readRemotes(repository),
      ]);
    const conflictCount = files.filter((file) => file.conflicted).length;
    const dirty = files.length > 0;
    const syncState = deriveSyncState({
      remotes: remotes.length,
      upstream: branchState.upstream,
      ahead: branchState.ahead,
      behind: branchState.behind,
      dirty,
      conflictCount,
    });
    return {
      ...branchState,
      head: headOutput.stdout.trim() || null,
      remoteHead: remoteHeadOutput.stdout.trim() || null,
      syncState,
      dirty,
      conflictCount,
      stashCount: stashOutput.stdout.split(/\r?\n/).filter(Boolean).length,
      lastCommit,
      lastRemoteCommit,
      remotes,
      operation: await this.detectOperation(gitDirectory),
      files,
    };
  }

  async diff(
    workspaceId: string,
    repositoryPath: string,
    requestedPath: string | null,
    staged: boolean,
  ): Promise<GitDiff> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const path = requestedPath === null ? null : this.validateRepoPath(requestedPath);
    if (path && !staged) {
      const state = await this.status(workspaceId, repositoryPath);
      if (state.files.some((file) => file.path === path && file.untracked)) {
        return this.untrackedDiff(repository, path);
      }
    }
    const args = [
      'diff',
      ...(staged ? ['--cached'] : []),
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--unified=3',
      ...(path ? ['--', path] : []),
    ];
    const output = await runGit(repository, args);
    return truncateDiff(path, staged, output.stdout);
  }

  async stage(
    workspaceId: string,
    repositoryPath: string,
    paths: string[],
  ): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const args = ['add', '--', ...paths.map((path) => this.validateRepoPath(path))];
    return operationOutput(await runGit(repository, args), args);
  }

  async unstage(
    workspaceId: string,
    repositoryPath: string,
    paths: string[],
  ): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const safePaths = paths.map((path) => this.validateRepoPath(path));
    const head = await runGit(repository, ['rev-parse', '--verify', 'HEAD'], {
      acceptedExitCodes: [0, 128],
    });
    const args = head.stdout.trim()
      ? ['restore', '--staged', '--', ...safePaths]
      : ['rm', '--cached', '--ignore-unmatch', '-r', '--', ...safePaths];
    return operationOutput(await runGit(repository, args), args);
  }

  async discard(
    workspaceId: string,
    repositoryPath: string,
    paths: string[],
  ): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const safePaths = paths.map((path) => this.validateRepoPath(path));
    const state = await this.status(workspaceId, repositoryPath);
    const untracked = new Set(
      state.files.filter((file) => file.untracked).map((file) => file.path),
    );
    const trackedPaths = safePaths.filter((path) => !untracked.has(path));
    const commands: string[] = [];
    if (trackedPaths.length > 0) {
      const args = ['restore', '--worktree', '--', ...trackedPaths];
      await runGit(repository, args);
      commands.push(displayCommand(args));
    }
    for (const path of safePaths.filter((candidate) => untracked.has(candidate))) {
      const absolute = resolve(repository, ...path.split('/'));
      ensureInside(repository, absolute);
      await lstat(absolute);
      await this.moveToTrash(absolute);
      commands.push(`Papelera: ${path}`);
    }
    return { output: 'Cambios descartados.', command: commands.join('\n') };
  }

  async commit(
    workspaceId: string,
    repositoryPath: string,
    message: string,
  ): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    await this.requireIdentity(repository);
    const args = ['commit', '-m', message];
    const output = await runGit(repository, args, { timeout: 60_000 });
    return operationOutput(output, args);
  }

  async identity(workspaceId: string, repositoryPath: string): Promise<GitIdentity> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    return this.readIdentity(repository);
  }

  async configureIdentity(
    workspaceId: string,
    repositoryPath: string,
    rawName: string,
    rawEmail: string,
  ): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const name = validateIdentityName(rawName);
    const email = validateIdentityEmail(rawEmail);
    const nameArgs = ['config', '--local', 'user.name', name];
    const emailArgs = ['config', '--local', 'user.email', email];
    const previous = parseIdentityConfig(
      (
        await runGit(repository, ['config', '--local', '--get-regexp', '^user\\.(name|email)$'], {
          acceptedExitCodes: [0, 1],
        })
      ).stdout,
    );
    await runGit(repository, nameArgs);
    try {
      await runGit(repository, emailArgs);
    } catch (error) {
      await restoreLocalConfig(repository, 'user.name', previous.name).catch(() => undefined);
      throw error;
    }
    return {
      output: 'Identidad Git configurada para este repositorio.',
      command: `${displayCommand(nameArgs)}\n${displayCommand(emailArgs)}`,
    };
  }

  async branches(workspaceId: string, repositoryPath: string): Promise<GitBranch[]> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const output = await runGit(repository, [
      'for-each-ref',
      '--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)',
      'refs/heads',
      'refs/remotes',
    ]);
    return output.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line): GitBranch | null => {
        const [ref = '', name = '', head = '', upstream = ''] = line.split('\0');
        const remote = ref.startsWith('refs/remotes/');
        if (!name || (remote && name.endsWith('/HEAD'))) return null;
        return {
          name,
          current: head === '*',
          remote,
          upstream: upstream || null,
        };
      })
      .filter((branch): branch is GitBranch => branch !== null)
      .sort(
        (left, right) =>
          Number(left.remote) - Number(right.remote) || left.name.localeCompare(right.name),
      );
  }

  async remotes(workspaceId: string, repositoryPath: string): Promise<GitRemote[]> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    return this.readRemotes(repository);
  }

  async setRemote(
    workspaceId: string,
    repositoryPath: string,
    remote: string,
    rawUrl: string,
  ): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote)) {
      throw new AppError('GIT_REMOTE_INVALID', 'El nombre del remoto no es válido.');
    }
    const url = validateRemoteUrl(rawUrl);
    const existing = (await runGit(repository, ['remote'])).stdout.split(/\r?\n/).filter(Boolean);
    const args = existing.includes(remote)
      ? ['remote', 'set-url', remote, url]
      : ['remote', 'add', remote, url];
    const output = await runGit(repository, args);
    return operationOutput(output, args);
  }

  async createBranch(
    workspaceId: string,
    repositoryPath: string,
    branch: string,
  ): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    await runGit(repository, ['check-ref-format', '--branch', branch]);
    const args = ['switch', '-c', branch];
    return operationOutput(await runGit(repository, args), args);
  }

  async checkout(
    workspaceId: string,
    repositoryPath: string,
    branch: string,
  ): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const available = await this.branches(workspaceId, repositoryPath);
    const target = available.find((candidate) => candidate.name === branch);
    if (!target) throw new AppError('GIT_BRANCH_NOT_FOUND', 'La rama seleccionada ya no existe.');
    const args = target.remote ? ['switch', '--track', branch] : ['switch', branch];
    return operationOutput(await runGit(repository, args), args);
  }

  async merge(
    workspaceId: string,
    repositoryPath: string,
    branch: string,
  ): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const available = await this.branches(workspaceId, repositoryPath);
    if (!available.some((candidate) => candidate.name === branch)) {
      throw new AppError('GIT_BRANCH_NOT_FOUND', 'La rama seleccionada ya no existe.');
    }
    const args = ['merge', '--no-edit', '--', branch];
    return operationOutput(await runGit(repository, args, { timeout: 60_000 }), args);
  }

  async abortMerge(workspaceId: string, repositoryPath: string): Promise<GitOperationResult> {
    const { repository, gitDirectory } = await this.resolveRepository(workspaceId, repositoryPath);
    if ((await this.detectOperation(gitDirectory)) !== 'merge') {
      throw new AppError('GIT_MERGE_NOT_ACTIVE', 'No hay un merge activo para cancelar.');
    }
    const args = ['merge', '--abort'];
    return operationOutput(await runGit(repository, args), args);
  }

  async analyzeSync(workspaceId: string, repositoryPath: string): Promise<GitSyncAnalysis> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const state = await this.status(workspaceId, repositoryPath);
    if (!state.branch || !state.upstream || !state.head) {
      throw new AppError(
        'GIT_SYNC_ANALYSIS_UNAVAILABLE',
        'La rama necesita HEAD y upstream para comparar la sincronización.',
        ['Configure el remoto y publique la rama antes de analizar diferencias.'],
      );
    }
    const mergeBaseOutput = await runGit(repository, ['merge-base', 'HEAD', state.upstream]);
    const mergeBase = mergeBaseOutput.stdout.trim();
    const [localCommits, remoteCommits, localFilesOutput, remoteFilesOutput] = await Promise.all([
      this.exclusiveCommits(repository, `${state.upstream}..HEAD`),
      this.exclusiveCommits(repository, `HEAD..${state.upstream}`),
      runGit(repository, ['diff', '--name-status', '-M', mergeBase, 'HEAD']),
      runGit(repository, ['diff', '--name-status', '-M', mergeBase, state.upstream]),
    ]);
    const localFiles = parseChangedFiles(localFilesOutput.stdout);
    const remoteFiles = parseChangedFiles(remoteFilesOutput.stdout);
    const remotePaths = new Set(remoteFiles.map((file) => file.path));
    return {
      repositoryPath,
      localBranch: state.branch,
      remoteBranch: state.upstream,
      ahead: state.ahead,
      behind: state.behind,
      workingTreeDirty: state.dirty,
      conflictCount: state.conflictCount,
      conflictedFiles: state.files.filter((file) => file.conflicted).map((file) => file.path),
      operation: state.operation,
      localCommits,
      remoteCommits,
      localFiles,
      remoteFiles,
      sharedFiles: localFiles
        .map((file) => file.path)
        .filter((path) => remotePaths.has(path))
        .sort((left, right) => left.localeCompare(right)),
      recommendedStrategy: 'merge',
    };
  }

  async integrateSync(
    workspaceId: string,
    repositoryPath: string,
    strategy: GitIntegrationStrategy,
  ): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const state = await this.status(workspaceId, repositoryPath);
    if (!state.upstream || !state.branch) {
      throw new AppError('GIT_UPSTREAM_MISSING', 'La rama actual no tiene upstream configurado.');
    }
    if (state.operation || state.conflictCount > 0) {
      throw new AppError(
        'GIT_OPERATION_ACTIVE',
        'Ya existe una operación Git que debe completarse o cancelarse.',
      );
    }
    if (state.dirty) {
      throw new AppError('GIT_LOCAL_CHANGES', 'Tienes cambios locales sin confirmar.', [
        'Revise, confirme o guarde temporalmente los cambios antes de integrar.',
      ]);
    }
    if (state.ahead === 0 || state.behind === 0) {
      throw new AppError(
        'GIT_SYNC_NOT_DIVERGED',
        'La rama ya no está divergente; actualice el análisis antes de continuar.',
      );
    }
    const args =
      strategy === 'merge'
        ? ['merge', '--no-edit', '--', state.upstream]
        : ['rebase', state.upstream];
    return operationOutput(await runGit(repository, args, { timeout: 120_000 }), args);
  }

  async continueIntegration(
    workspaceId: string,
    repositoryPath: string,
  ): Promise<GitOperationResult> {
    const { repository, gitDirectory } = await this.resolveRepository(workspaceId, repositoryPath);
    const state = await this.status(workspaceId, repositoryPath);
    const operation = await this.detectOperation(gitDirectory);
    if (operation !== 'merge' && operation !== 'rebase') {
      throw new AppError('GIT_OPERATION_NOT_ACTIVE', 'No hay un merge o rebase pendiente.');
    }
    if (state.conflictCount > 0) {
      throw new AppError('GIT_CONFLICT', 'Aún existen conflictos que requieren resolución manual.');
    }
    if (operation === 'merge') await this.requireIdentity(repository);
    const args =
      operation === 'merge'
        ? ['commit', '--no-edit']
        : ['-c', 'core.editor=true', 'rebase', '--continue'];
    return operationOutput(await runGit(repository, args, { timeout: 120_000 }), args);
  }

  async abortIntegration(workspaceId: string, repositoryPath: string): Promise<GitOperationResult> {
    const { repository, gitDirectory } = await this.resolveRepository(workspaceId, repositoryPath);
    const operation = await this.detectOperation(gitDirectory);
    if (operation !== 'merge' && operation !== 'rebase') {
      throw new AppError('GIT_OPERATION_NOT_ACTIVE', 'No hay un merge o rebase pendiente.');
    }
    const args = operation === 'merge' ? ['merge', '--abort'] : ['rebase', '--abort'];
    return operationOutput(await runGit(repository, args), args);
  }

  async stash(workspaceId: string, repositoryPath: string): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const state = await this.status(workspaceId, repositoryPath);
    if (!state.dirty) {
      throw new AppError('GIT_NOTHING_TO_STASH', 'No hay cambios locales que guardar en stash.');
    }
    const args = [
      'stash',
      'push',
      '--include-untracked',
      '-m',
      'Forge: antes de resolver sincronización',
    ];
    return operationOutput(await runGit(repository, args), args);
  }

  async fetch(workspaceId: string, repositoryPath: string): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const args = ['fetch', '--prune'];
    return operationOutput(await runGit(repository, args, { timeout: NETWORK_TIMEOUT }), args);
  }

  async pull(workspaceId: string, repositoryPath: string): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const state = await this.status(workspaceId, repositoryPath);
    if (state.ahead > 0 && state.behind > 0) {
      throw new AppError(
        'GIT_SYNC_DIVERGED',
        'No es posible realizar una actualización directa porque las ramas han divergido.',
        ['Abra Resolver sincronización y elija explícitamente Merge o Rebase.'],
      );
    }
    const args = ['pull', '--ff-only'];
    return operationOutput(await runGit(repository, args, { timeout: NETWORK_TIMEOUT }), args);
  }

  async push(workspaceId: string, repositoryPath: string): Promise<GitOperationResult> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const state = await this.status(workspaceId, repositoryPath);
    if (!state.branch) {
      throw new AppError('GIT_DETACHED_HEAD', 'No se puede publicar desde un HEAD separado.');
    }
    if (!state.head) {
      throw new AppError(
        'GIT_INITIAL_COMMIT_REQUIRED',
        'La rama todavía no contiene un commit que pueda publicarse.',
        ['Prepare los archivos y cree el commit inicial antes de hacer push.'],
      );
    }
    if (state.behind > 0) {
      throw new AppError(
        'GIT_REMOTE_CHANGES_PENDING',
        'El remoto contiene commits que aún no están integrados localmente.',
        [
          state.ahead > 0
            ? 'Resuelva la sincronización antes de publicar.'
            : 'Actualice la rama local antes de publicar.',
        ],
      );
    }
    let args = ['push'];
    if (!state.upstream) {
      const remotes = (await runGit(repository, ['remote'])).stdout.split(/\r?\n/).filter(Boolean);
      const remote = remotes.includes('origin')
        ? 'origin'
        : remotes.length === 1
          ? remotes[0]
          : null;
      if (!remote) {
        throw new AppError(
          'GIT_REMOTE_MISSING',
          'No existe un remoto único donde publicar la rama.',
        );
      }
      args = ['push', '--set-upstream', remote, state.branch];
    }
    return operationOutput(await runGit(repository, args, { timeout: NETWORK_TIMEOUT }), args);
  }

  async history(workspaceId: string, repositoryPath: string, limit: number): Promise<GitCommit[]> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const output = await runGit(
      repository,
      [
        'log',
        `--max-count=${limit}`,
        '--date=iso-strict',
        '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%D%x1e',
      ],
      { acceptedExitCodes: [0, 128] },
    );
    if (!output.stdout.trim()) return [];
    return output.stdout
      .split('\x1e')
      .map((record) => record.replace(/^[\r\n]+|[\r\n]+$/g, ''))
      .filter(Boolean)
      .map(parseCommitRecord);
  }

  private async readIdentity(repository: string): Promise<GitIdentity> {
    const effective = parseIdentityConfig(
      (
        await runGit(repository, ['config', '--get-regexp', '^user\\.(name|email)$'], {
          acceptedExitCodes: [0, 1],
        })
      ).stdout,
    );
    const name = effective.name;
    const email = effective.email;
    return {
      name,
      email,
      complete: name !== null && email !== null,
    };
  }

  private async requireIdentity(repository: string): Promise<void> {
    const identity = await this.readIdentity(repository);
    if (identity.complete) return;
    const missing = [!identity.name ? 'nombre' : null, !identity.email ? 'correo' : null].filter(
      (value): value is string => value !== null,
    );
    throw new AppError(
      'GIT_IDENTITY_MISSING',
      `Falta configurar ${missing.join(' y ')} para identificar el autor del commit.`,
      ['Complete la identidad Git desde Control de código fuente.'],
      { missingName: !identity.name, missingEmail: !identity.email },
    );
  }

  async show(workspaceId: string, repositoryPath: string, commit: string): Promise<GitDiff> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const output = await runGit(repository, [
      'show',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--format=fuller',
      '--stat',
      '--patch',
      commit,
    ]);
    return truncateDiff(null, false, output.stdout);
  }

  async conflict(
    workspaceId: string,
    repositoryPath: string,
    requestedPath: string,
  ): Promise<GitConflictContent> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const path = this.validateRepoPath(requestedPath);
    const state = await this.status(workspaceId, repositoryPath);
    const file = state.files.find((candidate) => candidate.path === path && candidate.conflicted);
    if (!file?.conflictType) {
      throw new AppError('GIT_CONFLICT_NOT_FOUND', 'El archivo ya no contiene un conflicto Git.');
    }
    const absolute = resolve(repository, ...path.split('/'));
    ensureInside(repository, absolute);
    const [base, local, remote, result] = await Promise.all([
      this.conflictStage(repository, 1, path),
      this.conflictStage(repository, 2, path),
      this.conflictStage(repository, 3, path),
      readTextFile(absolute),
    ]);
    return {
      path,
      type: file.conflictType,
      base,
      local,
      remote,
      result,
      version: contentVersion(result),
      hasMarkers: hasConflictMarkers(result),
    };
  }

  async resolveConflict(
    workspaceId: string,
    repositoryPath: string,
    requestedPath: string,
    content: string | null,
    expectedVersion: string,
  ): Promise<GitOperationResult> {
    if (content !== null && Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) {
      throw new AppError('FILE_TOO_LARGE', 'El resultado supera el límite de 5 MB.');
    }
    if (content !== null && hasConflictMarkers(content)) {
      throw new AppError(
        'GIT_CONFLICT_MARKERS_REMAIN',
        'El resultado aún contiene marcadores Git.',
        ['Elimine o resuelva todos los bloques <<<<<<<, ======= y >>>>>>> antes de continuar.'],
      );
    }
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const path = this.validateRepoPath(requestedPath);
    const state = await this.status(workspaceId, repositoryPath);
    if (!state.files.some((file) => file.path === path && file.conflicted)) {
      throw new AppError('GIT_CONFLICT_NOT_FOUND', 'El archivo ya no contiene un conflicto Git.');
    }
    const absolute = resolve(repository, ...path.split('/'));
    ensureInside(repository, absolute);
    const current = await readTextFile(absolute);
    if (contentVersion(current) !== expectedVersion) {
      throw new AppError('FILE_MODIFIED_EXTERNALLY', 'El conflicto cambió fuera de Forge.', [
        'Recargue el resolver y revise la versión actual antes de marcarlo como resuelto.',
      ]);
    }
    if (content === null) {
      const args = ['rm', '--', path];
      return operationOutput(await runGit(repository, args), args);
    }
    const before = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const temporary = join(dirname(absolute), `.forge-conflict-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: before?.mode });
      await rename(temporary, absolute);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    const args = ['add', '--', path];
    const output = await runGit(repository, args);
    return operationOutput(output, args);
  }

  async sensitiveFiles(
    workspaceId: string,
    repositoryPath: string,
    files: GitFileStatus[],
    patterns: string[],
  ): Promise<GitSensitiveFile[]> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    const matches: GitSensitiveFile[] = [];
    for (const file of files) {
      const pattern = patterns.find((candidate) => matchesPattern(file.path, candidate));
      if (!pattern) continue;
      const ignored = await runGit(
        repository,
        ['check-ignore', '--no-index', '--quiet', '--', file.path],
        {
          acceptedExitCodes: [0, 1],
        },
      );
      matches.push({
        path: file.path,
        pattern,
        staged: file.staged,
        untracked: file.untracked,
        ignoredByGit: ignored.exitCode === 0,
      });
    }
    return matches;
  }

  async githubInfo(workspaceId: string, repositoryPath: string): Promise<GitHubRemote | null> {
    const { repository } = await this.resolveRepository(workspaceId, repositoryPath);
    return this.detectGithub(repository);
  }

  private async workspaceRoot(workspaceId: string): Promise<string> {
    const workspace = this.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new AppError('WORKSPACE_NOT_FOUND', 'El workspace ya no está disponible.');
    }
    return realpath(workspace.rootPath);
  }

  private async inspectRepository(root: string, candidate: string): Promise<GitRepository> {
    const { repository } = await this.authorizeRepository(root, candidate);
    const [branchOutput, headOutput, github] = await Promise.all([
      runGit(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        acceptedExitCodes: [0, 1],
      }),
      runGit(repository, ['rev-parse', '--verify', 'HEAD'], { acceptedExitCodes: [0, 128] }),
      this.detectGithub(repository),
    ]);
    const relativePath = relative(root, repository).split('\\').join('/');
    const currentBranch = branchOutput.stdout.trim() || null;
    const head = headOutput.stdout.trim() || null;
    return {
      path: relativePath,
      name: basename(repository),
      currentBranch,
      head,
      detached: head !== null && currentBranch === null,
      github,
    };
  }

  private async resolveRepository(workspaceId: string, repositoryPath: string) {
    const root = await this.workspaceRoot(workspaceId);
    const normalized = normalizeRelative(repositoryPath, true);
    const candidate = normalized ? resolve(root, ...normalized.split('/')) : root;
    ensureInside(root, candidate);
    const authorized = await this.authorizeRepository(root, candidate);
    if (authorized.relativePath !== normalized) {
      throw new AppError('GIT_REPOSITORY_INVALID', 'La ruta del repositorio no está autorizada.');
    }
    return { root, repository: authorized.repository, gitDirectory: authorized.gitDirectory };
  }

  private async authorizeRepository(root: string, candidate: string) {
    const repository = await realpath(candidate);
    ensureInside(root, repository);
    const relativePath = relative(root, repository).split('\\').join('/');
    const normalizedCachePath =
      process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
    const cacheKey = `${root}\0${normalizedCachePath}`;
    const cached = this.authorizedRepositories.get(cacheKey);
    if (cached && samePath(cached.repository, repository)) {
      return { ...cached, relativePath };
    }

    const [topOutput, gitDirectoryOutput] = await Promise.all([
      runGit(repository, ['rev-parse', '--show-toplevel']),
      runGit(repository, ['rev-parse', '--absolute-git-dir']),
    ]);
    const topLevel = await realpath(topOutput.stdout.trim());
    if (!samePath(repository, topLevel)) {
      throw new AppError('GIT_REPOSITORY_INVALID', 'La raíz Git detectada no coincide.');
    }
    const gitDirectory = await realpath(gitDirectoryOutput.stdout.trim());
    ensureInside(root, gitDirectory);
    this.authorizedRepositories.set(cacheKey, { repository, gitDirectory });
    return { repository, gitDirectory, relativePath };
  }

  private validateRepoPath(path: string): string {
    return normalizeRelative(path);
  }

  private async commitAt(repository: string, ref: string): Promise<GitCommit | null> {
    const output = await runGit(
      repository,
      [
        'log',
        '--max-count=1',
        '--date=iso-strict',
        '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%D',
        ref,
        '--',
      ],
      { acceptedExitCodes: [0, 128] },
    );
    return output.exitCode === 0 && output.stdout.trim()
      ? parseCommitRecord(output.stdout.trim())
      : null;
  }

  private async exclusiveCommits(repository: string, range: string): Promise<GitSyncCommit[]> {
    const output = await runGit(repository, [
      'log',
      '--max-count=50',
      '--date=iso-strict',
      '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%D%x1e',
      range,
      '--',
    ]);
    const commits = output.stdout
      .split('\x1e')
      .map((record) => record.replace(/^[\r\n]+|[\r\n]+$/g, ''))
      .filter(Boolean)
      .map(parseCommitRecord);
    return Promise.all(
      commits.map(async (commit): Promise<GitSyncCommit> => {
        const files = await runGit(repository, [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--name-status',
          '-r',
          '-M',
          commit.hash,
        ]);
        return { ...commit, files: parseChangedFiles(files.stdout) };
      }),
    );
  }

  private async readRemotes(repository: string): Promise<GitRemote[]> {
    const names = (await runGit(repository, ['remote'])).stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 50);
    if (names.length === 0) return [];
    const credentialManagerAvailable = await this.hasCredentialManager(repository);
    return Promise.all(
      names.map(async (name): Promise<GitRemote> => {
        const [fetchOutput, pushOutput] = await Promise.all([
          runGit(repository, ['remote', 'get-url', name]),
          runGit(repository, ['remote', 'get-url', '--push', name]),
        ]);
        const fetchUrl = sanitizeRemoteUrl(fetchOutput.stdout.trim());
        const pushUrl = sanitizeRemoteUrl(pushOutput.stdout.trim());
        return {
          name,
          fetchUrl,
          pushUrl,
          github: parseGithubRemote(name, fetchUrl, credentialManagerAvailable),
        };
      }),
    );
  }

  private async conflictStage(
    repository: string,
    stage: 1 | 2 | 3,
    path: string,
  ): Promise<string | null> {
    const output = await runGit(repository, ['show', `:${stage}:${path}`], {
      acceptedExitCodes: [0, 128],
    });
    return output.exitCode === 0 ? output.stdout : null;
  }

  private async detectGithub(repository: string): Promise<GitHubRemote | null> {
    const parsed = (await this.readRemotes(repository))
      .map((remote) => remote.github)
      .filter((remote): remote is GitHubRemote => remote !== null);
    return parsed.find((item) => item.remote === 'origin') ?? parsed[0] ?? null;
  }

  private async hasCredentialManager(cwd: string): Promise<boolean> {
    credentialManagerAvailablePromise ??= runGit(cwd, ['credential-manager', '--version'])
      .then(() => true)
      .catch(() => false);
    return credentialManagerAvailablePromise;
  }

  private async detectOperation(gitDirectory: string): Promise<GitStatus['operation']> {
    const checks: Array<[GitStatus['operation'], string]> = [
      ['merge', 'MERGE_HEAD'],
      ['rebase', 'rebase-merge'],
      ['rebase', 'rebase-apply'],
      ['cherry-pick', 'CHERRY_PICK_HEAD'],
      ['revert', 'REVERT_HEAD'],
    ];
    for (const [operation, marker] of checks) {
      if (
        await access(join(gitDirectory, marker))
          .then(() => true)
          .catch(() => false)
      )
        return operation;
    }
    return null;
  }

  private async untrackedDiff(repository: string, path: string): Promise<GitDiff> {
    const absolute = resolve(repository, ...path.split('/'));
    ensureInside(repository, absolute);
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > MAX_OUTPUT_BYTES) {
      return {
        path,
        staged: false,
        content: 'El archivo nuevo es binario, no regular o demasiado grande para mostrar el diff.',
        truncated: info.size > MAX_OUTPUT_BYTES,
      };
    }
    const buffer = await readFile(absolute);
    if (buffer.subarray(0, 8_192).includes(0)) {
      return { path, staged: false, content: 'Archivo binario nuevo.', truncated: false };
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return {
        path,
        staged: false,
        content: 'Archivo nuevo con codificación no UTF-8.',
        truncated: false,
      };
    }
    const addedLines = content.split(/\r?\n/);
    if (addedLines.at(-1) === '') addedLines.pop();
    const patch = [
      `diff --git a/${path} b/${path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${path}`,
      `@@ -0,0 +1,${addedLines.length} @@`,
      ...addedLines.map((line) => `+${line}`),
    ].join('\n');
    return truncateDiff(path, false, patch);
  }
}

function parseBranchHeader(
  header: string,
): Pick<GitStatus, 'branch' | 'head' | 'detached' | 'upstream' | 'ahead' | 'behind'> {
  let value = header.startsWith('## ') ? header.slice(3) : header;
  value = value.replace(/^No commits yet on /, '').replace(/^Initial commit on /, '');
  const detached = value === 'HEAD (no branch)' || value.startsWith('HEAD ');
  const tracking = value.match(/\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]$/);
  const ahead = Number(tracking?.[1] ?? 0);
  const behind = Number(tracking?.[2] ?? 0);
  value = value.replace(/\s+\[.*\]$/, '');
  const [branchPart = '', upstreamPart] = value.split('...');
  return {
    branch: detached ? null : branchPart || null,
    head: null,
    detached,
    upstream: upstreamPart || null,
    ahead,
    behind,
  };
}

function conflictType(code: string): GitConflictType {
  const types: Record<string, GitConflictType> = {
    UU: 'both-modified',
    AA: 'both-added',
    DD: 'both-deleted',
    AU: 'added-by-us',
    UA: 'added-by-them',
    DU: 'deleted-by-us',
    UD: 'deleted-by-them',
  };
  return types[code] ?? 'both-modified';
}

function deriveSyncState(input: {
  remotes: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  conflictCount: number;
}): GitSyncState {
  if (input.conflictCount > 0) return 'conflicted';
  if (input.remotes === 0) return 'no-remote';
  if (!input.upstream) return 'no-upstream';
  if (input.ahead > 0 && input.behind > 0) return 'diverged';
  if (input.behind > 0) return 'behind';
  if (input.ahead > 0) return 'ahead';
  if (input.dirty) return 'dirty';
  return 'synchronized';
}

function parseChangedFiles(output: string): GitChangedFile[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line): GitChangedFile[] => {
      const [rawStatus = '', firstPath = '', secondPath] = line.split('\t');
      if (!rawStatus || !firstPath) return [];
      const renamed = rawStatus.startsWith('R') || rawStatus.startsWith('C');
      return [
        {
          status: rawStatus[0] ?? rawStatus,
          path: renamed && secondPath ? secondPath : firstPath,
          previousPath: renamed ? firstPath : null,
        },
      ];
    });
}

function parseCommitRecord(record: string): GitCommit {
  const [
    hash = '',
    shortHash = '',
    author = '',
    email = '',
    authoredAt = '',
    subject = '',
    decorations = '',
  ] = record.split('\0');
  return { hash, shortHash, author, email, authoredAt, subject, decorations };
}

function sanitizeRemoteUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      parsed.username = parsed.username === 'git' ? 'git' : '';
      parsed.password = '';
      return parsed.toString().replace(/\/$/, value.endsWith('/') ? '/' : '');
    } catch {
      return sanitizeOutput(value);
    }
  }
  return value.replace(/^([^@\s]+)@([^:]+):/, (match, username: string, host: string) =>
    username === 'git' ? match : `[redacted]@${host}:`,
  );
}

function validateRemoteUrl(rawUrl: string): string {
  const value = rawUrl.trim();
  if (
    !value ||
    value.includes('\0') ||
    /[\r\n]/.test(value) ||
    /^[a-z][a-z0-9+.-]*::/i.test(value)
  ) {
    throw new AppError('GIT_REMOTE_URL_INVALID', 'La URL del remoto no es válida o segura.');
  }
  if (isAbsolute(value) || win32.isAbsolute(value) || /^file:\/\//i.test(value)) return value;
  if (/^(?:git|[A-Za-z0-9._-]+)@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError(
      'GIT_REMOTE_URL_INVALID',
      'Use una URL HTTPS/SSH o una ruta local absoluta.',
    );
  }
  if (!['https:', 'ssh:', 'git:', 'file:'].includes(parsed.protocol)) {
    throw new AppError('GIT_REMOTE_URL_INVALID', 'El protocolo del remoto no está permitido.');
  }
  if (parsed.password || (parsed.username && parsed.username !== 'git')) {
    throw new AppError(
      'GIT_REMOTE_CREDENTIALS_BLOCKED',
      'No incluya tokens ni contraseñas en la URL.',
      ['Configure una URL sin credenciales; Git Credential Manager gestionará la autenticación.'],
    );
  }
  return value;
}

function matchesPattern(path: string, pattern: string): boolean {
  const normalizedPattern = pattern.replaceAll('\\', '/');
  const target = normalizedPattern.includes('/') ? path : basename(path);
  let expression = '';
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (character === '*' && normalizedPattern[index + 1] === '*') {
      expression += '.*';
      index += 1;
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else
      expression += character && /[.+^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`^${expression}$`, 'i').test(target);
}

async function readTextFile(path: string): Promise<string> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return '';
  if (!info.isFile() || info.size > 5 * 1024 * 1024) {
    throw new AppError('GIT_CONFLICT_UNSUPPORTED', 'El archivo conflictivo no es texto editable.');
  }
  const buffer = await readFile(path);
  if (buffer.subarray(0, 8_192).includes(0)) {
    throw new AppError('GIT_CONFLICT_UNSUPPORTED', 'El conflicto pertenece a un archivo binario.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new AppError('GIT_CONFLICT_UNSUPPORTED', 'El conflicto no utiliza codificación UTF-8.');
  }
}

function hasConflictMarkers(content: string): boolean {
  return /^(?:<{7}|={7}|>{7})(?:\s|$)/m.test(content);
}

function contentVersion(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function parseGithubRemote(
  remote: string,
  rawUrl: string,
  credentialManagerAvailable: boolean,
): GitHubRemote | null {
  const withoutCredentials = rawUrl.replace(/^(https?:\/\/)[^@/]+@/i, '$1');
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i,
  ];
  for (const pattern of patterns) {
    const match = withoutCredentials.match(pattern);
    const owner = match?.[1];
    const repository = match?.[2];
    if (
      owner &&
      repository &&
      owner.length <= 100 &&
      repository.length <= 200 &&
      /^[A-Za-z0-9-]+$/.test(owner) &&
      /^[A-Za-z0-9._-]+$/.test(repository)
    ) {
      return {
        remote,
        owner,
        repository,
        webUrl: `https://github.com/${owner}/${repository}`,
        credentialManagerAvailable,
      };
    }
  }
  return null;
}

function truncateDiff(path: string | null, staged: boolean, value: string): GitDiff {
  const bytes = Buffer.byteLength(value, 'utf8');
  return {
    path,
    staged,
    content:
      bytes > MAX_OUTPUT_BYTES
        ? Buffer.from(value, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8')
        : value,
    truncated: bytes > MAX_OUTPUT_BYTES,
  };
}

function displayCommand(args: string[]): string {
  const quote = (value: string) =>
    /^[A-Za-z0-9_./:@=-]+$/.test(value)
      ? value
      : `"${value.replaceAll('"', '\\"').replaceAll('\r', '').replaceAll('\n', ' ')}"`;
  return sanitizeOutput(`git ${args.map(quote).join(' ')}`);
}

function parseIdentityConfig(output: string): { name: string | null; email: string | null } {
  let name: string | null = null;
  let email: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const match = /^(user\.(?:name|email))\s(.*)$/i.exec(line);
    if (!match) continue;
    const value = (match[2] ?? '').trim() || null;
    if (match[1]?.toLocaleLowerCase() === 'user.name') name = value;
    if (match[1]?.toLocaleLowerCase() === 'user.email') email = value;
  }
  return { name, email };
}

function validateIdentityName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 200 || /[\0\r\n]/.test(name)) {
    throw new AppError('GIT_IDENTITY_INVALID', 'El nombre de autor no es válido.');
  }
  return name;
}

function validateIdentityEmail(value: string): string {
  const email = value.trim();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new AppError('GIT_IDENTITY_INVALID', 'El correo de autor no es válido.');
  }
  return email;
}

async function restoreLocalConfig(
  repository: string,
  key: 'user.name' | 'user.email',
  value: string | null,
): Promise<void> {
  if (value === null) {
    await runGit(repository, ['config', '--local', '--unset-all', key], {
      acceptedExitCodes: [0, 5],
    });
    return;
  }
  await runGit(repository, ['config', '--local', key, value]);
}

function operationOutput(output: GitCommandOutput, args: string[]): GitOperationResult {
  return {
    output: sanitizeOutput([output.stdout, output.stderr].filter(Boolean).join('\n')),
    command: displayCommand(args),
  };
}
