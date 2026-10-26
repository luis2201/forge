import { z } from 'zod';

export const environmentSchema = z.enum(['LOCAL', 'DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION']);
export type ForgeEnvironment = z.infer<typeof environmentSchema>;

export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  rootPath: z.string().min(1),
  environment: environmentSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastOpenedAt: z.string().datetime().nullable(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const applicationSettingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  telemetry: z.literal(false),
  showGitCommands: z.boolean().default(true),
  gitSensitivePatterns: z
    .array(z.string().trim().min(1).max(120))
    .min(1)
    .max(50)
    .default(['.env', '*.pem', '*.key', 'id_rsa', 'credentials.json']),
});
export type ApplicationSettings = z.infer<typeof applicationSettingsSchema>;

export const workspaceSettingsSchema = z.object({
  environment: environmentSchema,
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export const workspaceSettingsPatchSchema = workspaceSettingsSchema.partial();
export type WorkspaceSettingsPatch = z.infer<typeof workspaceSettingsPatchSchema>;

export const layoutSchema = z.object({
  sidebarWidth: z.number().int().min(220).max(520),
  bottomPanelOpen: z.boolean(),
  bottomPanelHeight: z.number().int().min(120).max(500),
});
export type WorkspaceLayout = z.infer<typeof layoutSchema>;

export const forgeErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  remediation: z.array(z.string()).optional(),
  correlationId: z.string().uuid(),
});
export type ForgeError = z.infer<typeof forgeErrorSchema>;

export type Result<T> = { ok: true; value: T } | { ok: false; error: ForgeError };

export const relativePathSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0'));

export const fileEntrySchema = z.object({
  name: z.string(),
  path: relativePathSchema,
  type: z.enum(['file', 'directory', 'symlink']),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const fileDocumentSchema = z.object({
  path: relativePathSchema,
  content: z.string(),
  version: z.string(),
  size: z.number().int().nonnegative(),
});
export type FileDocument = z.infer<typeof fileDocumentSchema>;

export const fileMutationSchema = z.object({
  path: relativePathSchema,
  version: z.string(),
  modifiedAt: z.string().datetime(),
});
export type FileMutation = z.infer<typeof fileMutationSchema>;

export const searchResultSchema = z.object({
  path: relativePathSchema,
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  preview: z.string(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  filesScanned: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export interface GitHubRemote {
  remote: string;
  owner: string;
  repository: string;
  webUrl: string;
  credentialManagerAvailable: boolean;
}

export interface GitRepository {
  path: string;
  name: string;
  currentBranch: string | null;
  head: string | null;
  detached: boolean;
  github: GitHubRemote | null;
}

export interface GitFileStatus {
  path: string;
  originalPath?: string;
  index: string;
  workingTree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  conflictType: GitConflictType | null;
}

export type GitConflictType =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'added-by-us'
  | 'added-by-them'
  | 'deleted-by-us'
  | 'deleted-by-them';

export type GitSyncState =
  | 'synchronized'
  | 'dirty'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'conflicted'
  | 'no-upstream'
  | 'no-remote';

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  github: GitHubRemote | null;
}

export interface GitIdentity {
  name: string | null;
  email: string | null;
  complete: boolean;
}

export interface GitStatus {
  branch: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  remoteHead: string | null;
  syncState: GitSyncState;
  dirty: boolean;
  conflictCount: number;
  stashCount: number;
  lastCommit: GitCommit | null;
  lastRemoteCommit: GitCommit | null;
  remotes: GitRemote[];
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
  files: GitFileStatus[];
}

export interface GitConflictContent {
  path: string;
  type: GitConflictType;
  base: string | null;
  local: string | null;
  remote: string | null;
  result: string;
  version: string;
  hasMarkers: boolean;
}

export interface GitSensitiveFile {
  path: string;
  pattern: string;
  staged: boolean;
  untracked: boolean;
  ignoredByGit: boolean;
}

export interface GitDiff {
  path: string | null;
  staged: boolean;
  content: string;
  truncated: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  authoredAt: string;
  subject: string;
  decorations: string;
}

export type GitIntegrationStrategy = 'merge' | 'rebase';

export interface GitChangedFile {
  path: string;
  previousPath: string | null;
  status: string;
}

export interface GitSyncCommit extends GitCommit {
  files: GitChangedFile[];
}

export interface GitSyncAnalysis {
  repositoryPath: string;
  localBranch: string;
  remoteBranch: string;
  ahead: number;
  behind: number;
  workingTreeDirty: boolean;
  conflictCount: number;
  conflictedFiles: string[];
  operation: GitStatus['operation'];
  localCommits: GitSyncCommit[];
  remoteCommits: GitSyncCommit[];
  localFiles: GitChangedFile[];
  remoteFiles: GitChangedFile[];
  sharedFiles: string[];
  recommendedStrategy: GitIntegrationStrategy;
}

export interface GitOperationResult {
  output: string;
  command: string;
}

export type RecommendationSeverity = 'INFO' | 'SUCCESS' | 'WARNING' | 'DANGER';

export interface RecommendationAction {
  id: string;
  label: string;
  kind: 'navigate' | 'command' | 'dismiss';
  command?:
    | 'git.fetch'
    | 'git.push'
    | 'git.configureRemote'
    | 'git.configureIdentity'
    | 'git.compareSync'
    | 'git.resolveSync'
    | 'git.reviewConflicts'
    | 'git.reviewSensitiveFiles';
}

export interface Recommendation {
  id: string;
  source: string;
  severity: RecommendationSeverity;
  title: string;
  message: string;
  details: string[];
  actions: RecommendationAction[];
  timestamp: string;
  context: Record<string, string | number | boolean | null>;
}

export interface GitOverview {
  status: GitStatus;
  identity: GitIdentity;
  recommendations: Recommendation[];
  sensitiveFiles: GitSensitiveFile[];
}

export const databaseEngineSchema = z.enum(['mysql', 'postgresql', 'sqlite']);
export type DatabaseEngine = z.infer<typeof databaseEngineSchema>;

export const databaseSslModeSchema = z.enum(['disabled', 'preferred', 'required']);
export type DatabaseSslMode = z.infer<typeof databaseSslModeSchema>;

export const databaseConnectionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    engine: databaseEngineSchema,
    environment: environmentSchema,
    host: z.string().trim().max(253).default(''),
    port: z.number().int().min(1).max(65_535).nullable().default(null),
    database: z.string().trim().max(256).default(''),
    username: z.string().trim().max(256).default(''),
    sslMode: databaseSslModeSchema.default('disabled'),
    sqlitePath: relativePathSchema.default(''),
  })
  .superRefine((value, context) => {
    if (value.engine === 'sqlite') {
      if (!value.sqlitePath) {
        context.addIssue({
          code: 'custom',
          path: ['sqlitePath'],
          message: 'SQLite requiere una ruta relativa al workspace.',
        });
      }
      return;
    }
    for (const field of ['host', 'database', 'username'] as const) {
      if (!value[field]) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} es obligatorio para conexiones remotas.`,
        });
      }
    }
  });
export type DatabaseConnectionInput = z.infer<typeof databaseConnectionInputSchema>;

export interface DatabaseConnectionProfile extends DatabaseConnectionInput {
  id: string;
  workspaceId: string;
  hasPassword: boolean;
  connected: boolean;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
}

export type DatabaseObjectType = 'table' | 'view';

export interface DatabaseObject {
  schema: string;
  name: string;
  type: DatabaseObjectType;
}

export interface DatabaseColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
  generated: boolean;
  autoIncrement: boolean;
}

export interface DatabaseForeignKey {
  column: string;
  referencedSchema: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface DatabaseTableStructure {
  schema: string;
  name: string;
  type: DatabaseObjectType;
  columns: DatabaseColumn[];
  foreignKeys: DatabaseForeignKey[];
}

export interface DatabaseCatalog {
  engine: DatabaseEngine;
  database: string;
  schemas: string[];
  objects: DatabaseObject[];
}

export const databaseValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type DatabaseValue = z.infer<typeof databaseValueSchema>;

export interface DatabaseResultColumn {
  name: string;
  dataType: string;
}

export interface DatabaseQueryResult {
  kind: 'rows' | 'mutation';
  columns: DatabaseResultColumn[];
  rows: DatabaseValue[][];
  rowCount: number;
  affectedRows: number;
  durationMs: number;
  truncated: boolean;
  command: string;
}

export interface DatabaseTableData {
  structure: DatabaseTableStructure;
  result: DatabaseQueryResult;
  offset: number;
  limit: number;
}

export interface DatabaseHistoryEntry {
  id: string;
  connectionId: string | null;
  connectionName: string;
  statement: string;
  succeeded: boolean;
  durationMs: number;
  rowCount: number;
  errorCode: string | null;
  executedAt: string;
}

export interface DatabaseImportPreview {
  importId: string;
  fileName: string;
  format: 'csv' | 'json';
  columns: string[];
  rows: DatabaseValue[][];
  totalRows: number;
  truncated: boolean;
}

export type DatabaseRowMutation =
  | { kind: 'insert'; values: Record<string, DatabaseValue> }
  | {
      kind: 'update';
      values: Record<string, DatabaseValue>;
      key: Record<string, DatabaseValue>;
    }
  | { kind: 'delete'; key: Record<string, DatabaseValue> };

export const terminalSessionSchema = z.object({
  id: z.string().uuid(),
  shell: z.string(),
  cwd: z.string(),
});
export type TerminalSession = z.infer<typeof terminalSessionSchema>;

export interface ForgeEventMap {
  'workspace.opened': { workspaceId: string };
  'workspace.closed': { workspaceId: string };
  'workspace.settingsChanged': { workspaceId: string };
  'application.settingsChanged': Record<string, never>;
  'file.changed': { workspaceId: string; path: string; kind: 'created' | 'changed' | 'deleted' };
  'git.changed': { workspaceId: string; repositoryPath: string };
  'database.changed': { workspaceId: string; connectionId: string };
  'recommendations.changed': { workspaceId: string; source: string };
  'terminal.data': { terminalId: string; data: string };
  'terminal.exited': { terminalId: string; exitCode: number };
}

export type ForgeEventName = keyof ForgeEventMap;

export type Unsubscribe = () => void;

export interface ForgeApi {
  workspace: {
    chooseAndOpen(): Promise<Result<Workspace | null>>;
    openRecent(workspaceId: string): Promise<Result<Workspace>>;
    close(workspaceId: string): Promise<Result<void>>;
    listRecent(limit?: number): Promise<Result<Workspace[]>>;
    updateSettings(
      workspaceId: string,
      patch: WorkspaceSettingsPatch,
    ): Promise<Result<WorkspaceSettings>>;
  };
  application: {
    getSettings(): Promise<Result<ApplicationSettings>>;
    updateSettings(patch: Partial<ApplicationSettings>): Promise<Result<ApplicationSettings>>;
    setDirtyState(count: number): Promise<Result<void>>;
  };
  layout: {
    get(workspaceId: string): Promise<Result<WorkspaceLayout>>;
    save(workspaceId: string, layout: WorkspaceLayout): Promise<Result<void>>;
  };
  file: {
    list(workspaceId: string, path?: string): Promise<Result<FileEntry[]>>;
    read(workspaceId: string, path: string): Promise<Result<FileDocument>>;
    write(
      workspaceId: string,
      path: string,
      content: string,
      expectedVersion: string,
    ): Promise<Result<FileMutation>>;
    createFile(workspaceId: string, path: string): Promise<Result<FileMutation>>;
    createDirectory(workspaceId: string, path: string): Promise<Result<void>>;
    rename(workspaceId: string, path: string, newName: string): Promise<Result<string>>;
    delete(workspaceId: string, path: string): Promise<Result<void>>;
  };
  search: {
    text(
      workspaceId: string,
      query: string,
      caseSensitive?: boolean,
    ): Promise<Result<SearchResponse>>;
  };
  git: {
    repositories(workspaceId: string): Promise<Result<GitRepository[]>>;
    status(workspaceId: string, repositoryPath: string): Promise<Result<GitStatus>>;
    overview(workspaceId: string, repositoryPath: string): Promise<Result<GitOverview>>;
    identity(workspaceId: string, repositoryPath: string): Promise<Result<GitIdentity>>;
    configureIdentity(
      workspaceId: string,
      repositoryPath: string,
      name: string,
      email: string,
    ): Promise<Result<GitOperationResult>>;
    init(
      workspaceId: string,
      repositoryPath: string,
      initialBranch: string,
    ): Promise<Result<GitOperationResult>>;
    diff(
      workspaceId: string,
      repositoryPath: string,
      path: string | null,
      staged: boolean,
    ): Promise<Result<GitDiff>>;
    stage(
      workspaceId: string,
      repositoryPath: string,
      paths: string[],
    ): Promise<Result<GitOperationResult>>;
    unstage(
      workspaceId: string,
      repositoryPath: string,
      paths: string[],
    ): Promise<Result<GitOperationResult>>;
    discard(
      workspaceId: string,
      repositoryPath: string,
      paths: string[],
      confirmed?: boolean,
    ): Promise<Result<GitOperationResult>>;
    commit(
      workspaceId: string,
      repositoryPath: string,
      message: string,
      confirmSensitive?: boolean,
    ): Promise<Result<GitOperationResult>>;
    branches(workspaceId: string, repositoryPath: string): Promise<Result<GitBranch[]>>;
    remotes(workspaceId: string, repositoryPath: string): Promise<Result<GitRemote[]>>;
    setRemote(
      workspaceId: string,
      repositoryPath: string,
      name: string,
      url: string,
    ): Promise<Result<GitOperationResult>>;
    createBranch(
      workspaceId: string,
      repositoryPath: string,
      name: string,
    ): Promise<Result<GitOperationResult>>;
    checkout(
      workspaceId: string,
      repositoryPath: string,
      branch: string,
      confirmed?: boolean,
    ): Promise<Result<GitOperationResult>>;
    merge(
      workspaceId: string,
      repositoryPath: string,
      branch: string,
      confirmed?: boolean,
    ): Promise<Result<GitOperationResult>>;
    abortMerge(workspaceId: string, repositoryPath: string): Promise<Result<GitOperationResult>>;
    analyzeSync(workspaceId: string, repositoryPath: string): Promise<Result<GitSyncAnalysis>>;
    integrateSync(
      workspaceId: string,
      repositoryPath: string,
      strategy: GitIntegrationStrategy,
      confirmed?: boolean,
    ): Promise<Result<GitOperationResult>>;
    continueIntegration(
      workspaceId: string,
      repositoryPath: string,
    ): Promise<Result<GitOperationResult>>;
    abortIntegration(
      workspaceId: string,
      repositoryPath: string,
      confirmed?: boolean,
    ): Promise<Result<GitOperationResult>>;
    stash(
      workspaceId: string,
      repositoryPath: string,
      confirmed?: boolean,
    ): Promise<Result<GitOperationResult>>;
    fetch(workspaceId: string, repositoryPath: string): Promise<Result<GitOperationResult>>;
    pull(workspaceId: string, repositoryPath: string): Promise<Result<GitOperationResult>>;
    push(workspaceId: string, repositoryPath: string): Promise<Result<GitOperationResult>>;
    history(
      workspaceId: string,
      repositoryPath: string,
      limit?: number,
    ): Promise<Result<GitCommit[]>>;
    show(workspaceId: string, repositoryPath: string, commit: string): Promise<Result<GitDiff>>;
    conflict(
      workspaceId: string,
      repositoryPath: string,
      path: string,
    ): Promise<Result<GitConflictContent>>;
    resolveConflict(
      workspaceId: string,
      repositoryPath: string,
      path: string,
      content: string | null,
      expectedVersion: string,
    ): Promise<Result<GitOperationResult>>;
  };
  github: {
    info(workspaceId: string, repositoryPath: string): Promise<Result<GitHubRemote | null>>;
    openRepository(workspaceId: string, repositoryPath: string): Promise<Result<void>>;
  };
  database: {
    listConnections(workspaceId: string): Promise<Result<DatabaseConnectionProfile[]>>;
    saveConnection(
      workspaceId: string,
      connectionId: string | null,
      profile: DatabaseConnectionInput,
      password?: string,
    ): Promise<Result<DatabaseConnectionProfile>>;
    deleteConnection(
      workspaceId: string,
      connectionId: string,
      confirmed?: boolean,
    ): Promise<Result<void>>;
    testConnection(
      workspaceId: string,
      profile: DatabaseConnectionInput,
      password?: string,
    ): Promise<Result<void>>;
    connect(workspaceId: string, connectionId: string): Promise<Result<DatabaseConnectionProfile>>;
    disconnect(workspaceId: string, connectionId: string): Promise<Result<void>>;
    catalog(workspaceId: string, connectionId: string): Promise<Result<DatabaseCatalog>>;
    structure(
      workspaceId: string,
      connectionId: string,
      schema: string,
      table: string,
    ): Promise<Result<DatabaseTableStructure>>;
    query(
      workspaceId: string,
      connectionId: string,
      statement: string,
      confirmed?: boolean,
    ): Promise<Result<DatabaseQueryResult>>;
    tableData(
      workspaceId: string,
      connectionId: string,
      schema: string,
      table: string,
      offset?: number,
      limit?: number,
    ): Promise<Result<DatabaseTableData>>;
    mutateRow(
      workspaceId: string,
      connectionId: string,
      schema: string,
      table: string,
      mutation: DatabaseRowMutation,
      confirmed?: boolean,
    ): Promise<Result<DatabaseQueryResult>>;
    history(workspaceId: string, limit?: number): Promise<Result<DatabaseHistoryEntry[]>>;
    clearHistory(workspaceId: string, confirmed?: boolean): Promise<Result<void>>;
    exportResult(
      workspaceId: string,
      connectionId: string,
      format: 'csv' | 'json',
      suggestedName: string,
      columns: string[],
      rows: DatabaseValue[][],
    ): Promise<Result<string | null>>;
    previewImport(workspaceId: string): Promise<Result<DatabaseImportPreview | null>>;
    applyImport(
      workspaceId: string,
      connectionId: string,
      importId: string,
      schema: string,
      table: string,
      confirmed?: boolean,
    ): Promise<Result<DatabaseQueryResult>>;
  };
  recommendations: {
    list(workspaceId: string, source?: string): Promise<Result<Recommendation[]>>;
  };
  terminal: {
    create(workspaceId: string, cols: number, rows: number): Promise<Result<TerminalSession>>;
    write(terminalId: string, data: string): Promise<Result<void>>;
    resize(terminalId: string, cols: number, rows: number): Promise<Result<void>>;
    close(terminalId: string): Promise<Result<void>>;
  };
  events: {
    subscribe<K extends ForgeEventName>(
      name: K,
      listener: (payload: ForgeEventMap[K]) => void,
    ): Unsubscribe;
  };
}

export const commandEnvelopeSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('workspace.chooseAndOpen'), input: z.object({}) }),
  z.object({
    name: z.literal('workspace.openRecent'),
    input: z.object({ workspaceId: z.string().uuid() }),
  }),
  z.object({
    name: z.literal('workspace.close'),
    input: z.object({ workspaceId: z.string().uuid() }),
  }),
  z.object({
    name: z.literal('workspace.listRecent'),
    input: z.object({ limit: z.number().int().min(1).max(50).default(12) }),
  }),
  z.object({
    name: z.literal('workspace.updateSettings'),
    input: z.object({ workspaceId: z.string().uuid(), patch: workspaceSettingsPatchSchema }),
  }),
  z.object({ name: z.literal('application.getSettings'), input: z.object({}) }),
  z.object({
    name: z.literal('application.updateSettings'),
    input: z.object({ patch: applicationSettingsSchema.partial() }),
  }),
  z.object({
    name: z.literal('application.setDirtyState'),
    input: z.object({ count: z.number().int().min(0).max(10_000) }),
  }),
  z.object({ name: z.literal('layout.get'), input: z.object({ workspaceId: z.string().uuid() }) }),
  z.object({
    name: z.literal('layout.save'),
    input: z.object({ workspaceId: z.string().uuid(), layout: layoutSchema }),
  }),
  z.object({
    name: z.literal('file.list'),
    input: z.object({ workspaceId: z.string().uuid(), path: relativePathSchema.default('') }),
  }),
  z.object({
    name: z.literal('file.read'),
    input: z.object({ workspaceId: z.string().uuid(), path: relativePathSchema }),
  }),
  z.object({
    name: z.literal('file.write'),
    input: z.object({
      workspaceId: z.string().uuid(),
      path: relativePathSchema,
      content: z.string().max(5 * 1024 * 1024),
      expectedVersion: z.string().max(120),
    }),
  }),
  z.object({
    name: z.literal('file.createFile'),
    input: z.object({ workspaceId: z.string().uuid(), path: relativePathSchema }),
  }),
  z.object({
    name: z.literal('file.createDirectory'),
    input: z.object({ workspaceId: z.string().uuid(), path: relativePathSchema }),
  }),
  z.object({
    name: z.literal('file.rename'),
    input: z.object({
      workspaceId: z.string().uuid(),
      path: relativePathSchema,
      newName: z.string().trim().min(1).max(255),
    }),
  }),
  z.object({
    name: z.literal('file.delete'),
    input: z.object({ workspaceId: z.string().uuid(), path: relativePathSchema }),
  }),
  z.object({
    name: z.literal('search.text'),
    input: z.object({
      workspaceId: z.string().uuid(),
      query: z.string().min(1).max(200),
      caseSensitive: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal('git.repositories'),
    input: z.object({ workspaceId: z.string().uuid() }),
  }),
  z.object({
    name: z.literal('git.init'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      initialBranch: z.string().trim().min(1).max(255),
    }),
  }),
  z.object({
    name: z.literal('git.status'),
    input: z.object({ workspaceId: z.string().uuid(), repositoryPath: relativePathSchema }),
  }),
  z.object({
    name: z.literal('git.overview'),
    input: z.object({ workspaceId: z.string().uuid(), repositoryPath: relativePathSchema }),
  }),
  z.object({
    name: z.literal('git.identity'),
    input: z.object({ workspaceId: z.string().uuid(), repositoryPath: relativePathSchema }),
  }),
  z.object({
    name: z.literal('git.configureIdentity'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      name: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .refine((value) => !/[\0\r\n]/.test(value)),
      email: z
        .string()
        .trim()
        .min(3)
        .max(320)
        .refine((value) => /^[^\s@]+@[^\s@]+$/.test(value)),
    }),
  }),
  z.object({
    name: z.literal('git.diff'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      path: relativePathSchema.nullable(),
      staged: z.boolean(),
    }),
  }),
  z.object({
    name: z.literal('git.stage'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      paths: z.array(relativePathSchema).min(1).max(200),
    }),
  }),
  z.object({
    name: z.literal('git.unstage'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      paths: z.array(relativePathSchema).min(1).max(200),
    }),
  }),
  z.object({
    name: z.literal('git.discard'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      paths: z.array(relativePathSchema).min(1).max(200),
      confirmed: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal('git.commit'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      message: z.string().trim().min(1).max(10_000),
      confirmSensitive: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal('git.branches'),
    input: z.object({ workspaceId: z.string().uuid(), repositoryPath: relativePathSchema }),
  }),
  z.object({
    name: z.literal('git.remotes'),
    input: z.object({ workspaceId: z.string().uuid(), repositoryPath: relativePathSchema }),
  }),
  z.object({
    name: z.literal('git.setRemote'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      remote: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      url: z
        .string()
        .trim()
        .min(1)
        .max(2048)
        .refine((value) => !value.includes('\0')),
    }),
  }),
  z.object({
    name: z.literal('git.createBranch'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      branch: z.string().trim().min(1).max(255),
    }),
  }),
  z.object({
    name: z.literal('git.checkout'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      branch: z.string().min(1).max(512),
      confirmed: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal('git.merge'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      branch: z.string().min(1).max(512),
      confirmed: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal('git.abortMerge'),
    input: z.object({ workspaceId: z.string().uuid(), repositoryPath: relativePathSchema }),
  }),
  z.object({
    name: z.literal('git.analyzeSync'),
    input: z.object({ workspaceId: z.string().uuid(), repositoryPath: relativePathSchema }),
  }),
  z.object({
    name: z.literal('git.integrateSync'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      strategy: z.enum(['merge', 'rebase']),
      confirmed: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal('git.continueIntegration'),
    input: z.object({ workspaceId: z.string().uuid(), repositoryPath: relativePathSchema }),
  }),
  z.object({
    name: z.literal('git.abortIntegration'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      confirmed: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal('git.stash'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      confirmed: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.enum(['git.fetch', 'git.pull', 'git.push']),
    input: z.object({ workspaceId: z.string().uuid(), repositoryPath: relativePathSchema }),
  }),
  z.object({
    name: z.literal('git.history'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      limit: z.number().int().min(1).max(200).default(100),
    }),
  }),
  z.object({
    name: z.literal('git.show'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      commit: z.string().regex(/^[0-9a-f]{7,40}$/i),
    }),
  }),
  z.object({
    name: z.literal('git.conflict'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      path: relativePathSchema,
    }),
  }),
  z.object({
    name: z.literal('git.resolveConflict'),
    input: z.object({
      workspaceId: z.string().uuid(),
      repositoryPath: relativePathSchema,
      path: relativePathSchema,
      content: z
        .string()
        .max(5 * 1024 * 1024)
        .nullable(),
      expectedVersion: z.string().regex(/^[0-9a-f]{64}$/i),
    }),
  }),
  z.object({
    name: z.enum(['github.info', 'github.openRepository']),
    input: z.object({ workspaceId: z.string().uuid(), repositoryPath: relativePathSchema }),
  }),
  z.object({
    name: z.literal('database.listConnections'),
    input: z.object({ workspaceId: z.string().uuid() }),
  }),
  z.object({
    name: z.literal('database.saveConnection'),
    input: z.object({
      workspaceId: z.string().uuid(),
      connectionId: z.string().uuid().nullable(),
      profile: databaseConnectionInputSchema,
      password: z.string().max(4096).optional(),
    }),
  }),
  z.object({
    name: z.literal('database.deleteConnection'),
    input: z.object({
      workspaceId: z.string().uuid(),
      connectionId: z.string().uuid(),
      confirmed: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal('database.testConnection'),
    input: z.object({
      workspaceId: z.string().uuid(),
      profile: databaseConnectionInputSchema,
      password: z.string().max(4096).optional(),
    }),
  }),
  z.object({
    name: z.enum(['database.connect', 'database.disconnect', 'database.catalog']),
    input: z.object({ workspaceId: z.string().uuid(), connectionId: z.string().uuid() }),
  }),
  z.object({
    name: z.literal('database.structure'),
    input: z.object({
      workspaceId: z.string().uuid(),
      connectionId: z.string().uuid(),
      schema: z.string().max(256),
      table: z.string().min(1).max(256),
    }),
  }),
  z.object({
    name: z.literal('database.query'),
    input: z.object({
      workspaceId: z.string().uuid(),
      connectionId: z.string().uuid(),
      statement: z
        .string()
        .trim()
        .min(1)
        .max(1024 * 1024),
      confirmed: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal('database.tableData'),
    input: z.object({
      workspaceId: z.string().uuid(),
      connectionId: z.string().uuid(),
      schema: z.string().max(256),
      table: z.string().min(1).max(256),
      offset: z.number().int().min(0).max(10_000_000).default(0),
      limit: z.number().int().min(1).max(1000).default(200),
    }),
  }),
  z.object({
    name: z.literal('database.mutateRow'),
    input: z.object({
      workspaceId: z.string().uuid(),
      connectionId: z.string().uuid(),
      schema: z.string().max(256),
      table: z.string().min(1).max(256),
      mutation: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('insert'),
          values: z.record(z.string(), databaseValueSchema),
        }),
        z.object({
          kind: z.literal('update'),
          values: z.record(z.string(), databaseValueSchema),
          key: z.record(z.string(), databaseValueSchema),
        }),
        z.object({
          kind: z.literal('delete'),
          key: z.record(z.string(), databaseValueSchema),
        }),
      ]),
      confirmed: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal('database.history'),
    input: z.object({
      workspaceId: z.string().uuid(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
  }),
  z.object({
    name: z.literal('database.clearHistory'),
    input: z.object({
      workspaceId: z.string().uuid(),
      confirmed: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal('database.exportResult'),
    input: z.object({
      workspaceId: z.string().uuid(),
      connectionId: z.string().uuid(),
      format: z.enum(['csv', 'json']),
      suggestedName: z.string().trim().min(1).max(180),
      columns: z.array(z.string().max(256)).max(500),
      rows: z
        .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(500))
        .max(1000),
    }),
  }),
  z.object({
    name: z.literal('database.previewImport'),
    input: z.object({ workspaceId: z.string().uuid() }),
  }),
  z.object({
    name: z.literal('database.applyImport'),
    input: z.object({
      workspaceId: z.string().uuid(),
      connectionId: z.string().uuid(),
      importId: z.string().uuid(),
      schema: z.string().max(256),
      table: z.string().min(1).max(256),
      confirmed: z.boolean().default(false),
    }),
  }),
  z.object({
    name: z.literal('recommendations.list'),
    input: z.object({
      workspaceId: z.string().uuid(),
      source: z.string().trim().min(1).max(100).optional(),
    }),
  }),
  z.object({
    name: z.literal('terminal.create'),
    input: z.object({
      workspaceId: z.string().uuid(),
      cols: z.number().int().min(20).max(500),
      rows: z.number().int().min(5).max(200),
    }),
  }),
  z.object({
    name: z.literal('terminal.write'),
    input: z.object({ terminalId: z.string().uuid(), data: z.string().max(64 * 1024) }),
  }),
  z.object({
    name: z.literal('terminal.resize'),
    input: z.object({
      terminalId: z.string().uuid(),
      cols: z.number().int().min(20).max(500),
      rows: z.number().int().min(5).max(200),
    }),
  }),
  z.object({
    name: z.literal('terminal.close'),
    input: z.object({ terminalId: z.string().uuid() }),
  }),
]);
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
