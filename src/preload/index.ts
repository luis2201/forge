import { contextBridge, ipcRenderer } from 'electron';
import type {
  ApplicationSettings,
  DatabaseCatalog,
  DatabaseConnectionInput,
  DatabaseConnectionProfile,
  DatabaseHistoryEntry,
  DatabaseImportPreview,
  DatabaseQueryResult,
  DatabaseRowMutation,
  DatabaseTableData,
  DatabaseTableStructure,
  DatabaseValue,
  FileDocument,
  FileEntry,
  FileMutation,
  ForgeApi,
  ForgeEventMap,
  ForgeEventName,
  GitBranch,
  GitCommit,
  GitConflictContent,
  GitDiff,
  GitHubRemote,
  GitIdentity,
  GitOperationResult,
  GitOverview,
  GitRemote,
  GitRepository,
  GitStatus,
  GitSyncAnalysis,
  Recommendation,
  Result,
  SearchResponse,
  TerminalSession,
  Workspace,
  WorkspaceLayout,
  WorkspaceSettings,
} from '../shared/contracts.js';

const invoke = <T>(name: string, input: object): Promise<Result<T>> =>
  ipcRenderer.invoke('forge:command', { name, input }) as Promise<Result<T>>;
const allowedEvents = new Set<ForgeEventName>([
  'workspace.opened',
  'workspace.closed',
  'workspace.settingsChanged',
  'application.settingsChanged',
  'file.changed',
  'git.changed',
  'database.changed',
  'recommendations.changed',
  'terminal.data',
  'terminal.exited',
]);

const api: ForgeApi = {
  workspace: {
    chooseAndOpen: () => invoke<Workspace | null>('workspace.chooseAndOpen', {}),
    openRecent: (workspaceId) => invoke<Workspace>('workspace.openRecent', { workspaceId }),
    close: (workspaceId) => invoke<void>('workspace.close', { workspaceId }),
    listRecent: (limit = 12) => invoke<Workspace[]>('workspace.listRecent', { limit }),
    updateSettings: (workspaceId, patch) =>
      invoke<WorkspaceSettings>('workspace.updateSettings', { workspaceId, patch }),
  },
  application: {
    getSettings: () => invoke<ApplicationSettings>('application.getSettings', {}),
    updateSettings: (patch) => invoke<ApplicationSettings>('application.updateSettings', { patch }),
    setDirtyState: (count) => invoke<void>('application.setDirtyState', { count }),
  },
  layout: {
    get: (workspaceId) => invoke<WorkspaceLayout>('layout.get', { workspaceId }),
    save: (workspaceId, layout) => invoke<void>('layout.save', { workspaceId, layout }),
  },
  file: {
    list: (workspaceId, path = '') => invoke<FileEntry[]>('file.list', { workspaceId, path }),
    read: (workspaceId, path) => invoke<FileDocument>('file.read', { workspaceId, path }),
    write: (workspaceId, path, content, expectedVersion) =>
      invoke<FileMutation>('file.write', { workspaceId, path, content, expectedVersion }),
    createFile: (workspaceId, path) =>
      invoke<FileMutation>('file.createFile', { workspaceId, path }),
    createDirectory: (workspaceId, path) =>
      invoke<void>('file.createDirectory', { workspaceId, path }),
    rename: (workspaceId, path, newName) =>
      invoke<string>('file.rename', { workspaceId, path, newName }),
    delete: (workspaceId, path) => invoke<void>('file.delete', { workspaceId, path }),
  },
  search: {
    text: (workspaceId, query, caseSensitive = false) =>
      invoke<SearchResponse>('search.text', { workspaceId, query, caseSensitive }),
  },
  git: {
    repositories: (workspaceId) => invoke<GitRepository[]>('git.repositories', { workspaceId }),
    init: (workspaceId, repositoryPath, initialBranch) =>
      invoke<GitOperationResult>('git.init', { workspaceId, repositoryPath, initialBranch }),
    status: (workspaceId, repositoryPath) =>
      invoke<GitStatus>('git.status', { workspaceId, repositoryPath }),
    overview: (workspaceId, repositoryPath) =>
      invoke<GitOverview>('git.overview', { workspaceId, repositoryPath }),
    identity: (workspaceId, repositoryPath) =>
      invoke<GitIdentity>('git.identity', { workspaceId, repositoryPath }),
    configureIdentity: (workspaceId, repositoryPath, name, email) =>
      invoke<GitOperationResult>('git.configureIdentity', {
        workspaceId,
        repositoryPath,
        name,
        email,
      }),
    diff: (workspaceId, repositoryPath, path, staged) =>
      invoke<GitDiff>('git.diff', { workspaceId, repositoryPath, path, staged }),
    stage: (workspaceId, repositoryPath, paths) =>
      invoke<GitOperationResult>('git.stage', { workspaceId, repositoryPath, paths }),
    unstage: (workspaceId, repositoryPath, paths) =>
      invoke<GitOperationResult>('git.unstage', { workspaceId, repositoryPath, paths }),
    discard: (workspaceId, repositoryPath, paths, confirmed = false) =>
      invoke<GitOperationResult>('git.discard', {
        workspaceId,
        repositoryPath,
        paths,
        confirmed,
      }),
    commit: (workspaceId, repositoryPath, message, confirmSensitive = false) =>
      invoke<GitOperationResult>('git.commit', {
        workspaceId,
        repositoryPath,
        message,
        confirmSensitive,
      }),
    branches: (workspaceId, repositoryPath) =>
      invoke<GitBranch[]>('git.branches', { workspaceId, repositoryPath }),
    remotes: (workspaceId, repositoryPath) =>
      invoke<GitRemote[]>('git.remotes', { workspaceId, repositoryPath }),
    setRemote: (workspaceId, repositoryPath, remote, url) =>
      invoke<GitOperationResult>('git.setRemote', { workspaceId, repositoryPath, remote, url }),
    createBranch: (workspaceId, repositoryPath, branch) =>
      invoke<GitOperationResult>('git.createBranch', { workspaceId, repositoryPath, branch }),
    checkout: (workspaceId, repositoryPath, branch, confirmed = false) =>
      invoke<GitOperationResult>('git.checkout', {
        workspaceId,
        repositoryPath,
        branch,
        confirmed,
      }),
    merge: (workspaceId, repositoryPath, branch, confirmed = false) =>
      invoke<GitOperationResult>('git.merge', {
        workspaceId,
        repositoryPath,
        branch,
        confirmed,
      }),
    abortMerge: (workspaceId, repositoryPath) =>
      invoke<GitOperationResult>('git.abortMerge', { workspaceId, repositoryPath }),
    analyzeSync: (workspaceId, repositoryPath) =>
      invoke<GitSyncAnalysis>('git.analyzeSync', { workspaceId, repositoryPath }),
    integrateSync: (workspaceId, repositoryPath, strategy, confirmed = false) =>
      invoke<GitOperationResult>('git.integrateSync', {
        workspaceId,
        repositoryPath,
        strategy,
        confirmed,
      }),
    continueIntegration: (workspaceId, repositoryPath) =>
      invoke<GitOperationResult>('git.continueIntegration', { workspaceId, repositoryPath }),
    abortIntegration: (workspaceId, repositoryPath, confirmed = false) =>
      invoke<GitOperationResult>('git.abortIntegration', {
        workspaceId,
        repositoryPath,
        confirmed,
      }),
    stash: (workspaceId, repositoryPath, confirmed = false) =>
      invoke<GitOperationResult>('git.stash', { workspaceId, repositoryPath, confirmed }),
    fetch: (workspaceId, repositoryPath) =>
      invoke<GitOperationResult>('git.fetch', { workspaceId, repositoryPath }),
    pull: (workspaceId, repositoryPath) =>
      invoke<GitOperationResult>('git.pull', { workspaceId, repositoryPath }),
    push: (workspaceId, repositoryPath) =>
      invoke<GitOperationResult>('git.push', { workspaceId, repositoryPath }),
    history: (workspaceId, repositoryPath, limit = 100) =>
      invoke<GitCommit[]>('git.history', { workspaceId, repositoryPath, limit }),
    show: (workspaceId, repositoryPath, commit) =>
      invoke<GitDiff>('git.show', { workspaceId, repositoryPath, commit }),
    conflict: (workspaceId, repositoryPath, path) =>
      invoke<GitConflictContent>('git.conflict', { workspaceId, repositoryPath, path }),
    resolveConflict: (workspaceId, repositoryPath, path, content, expectedVersion) =>
      invoke<GitOperationResult>('git.resolveConflict', {
        workspaceId,
        repositoryPath,
        path,
        content,
        expectedVersion,
      }),
  },
  github: {
    info: (workspaceId, repositoryPath) =>
      invoke<GitHubRemote | null>('github.info', { workspaceId, repositoryPath }),
    openRepository: (workspaceId, repositoryPath) =>
      invoke<void>('github.openRepository', { workspaceId, repositoryPath }),
  },
  database: {
    listConnections: (workspaceId) =>
      invoke<DatabaseConnectionProfile[]>('database.listConnections', { workspaceId }),
    saveConnection: (workspaceId, connectionId, profile, password) =>
      invoke<DatabaseConnectionProfile>('database.saveConnection', {
        workspaceId,
        connectionId,
        profile,
        ...(password === undefined ? {} : { password }),
      }),
    deleteConnection: (workspaceId, connectionId, confirmed = false) =>
      invoke<void>('database.deleteConnection', { workspaceId, connectionId, confirmed }),
    testConnection: (workspaceId, profile: DatabaseConnectionInput, password?: string) =>
      invoke<void>('database.testConnection', {
        workspaceId,
        profile,
        ...(password === undefined ? {} : { password }),
      }),
    connect: (workspaceId, connectionId) =>
      invoke<DatabaseConnectionProfile>('database.connect', { workspaceId, connectionId }),
    disconnect: (workspaceId, connectionId) =>
      invoke<void>('database.disconnect', { workspaceId, connectionId }),
    catalog: (workspaceId, connectionId) =>
      invoke<DatabaseCatalog>('database.catalog', { workspaceId, connectionId }),
    structure: (workspaceId, connectionId, schema, table) =>
      invoke<DatabaseTableStructure>('database.structure', {
        workspaceId,
        connectionId,
        schema,
        table,
      }),
    query: (workspaceId, connectionId, statement, confirmed = false) =>
      invoke<DatabaseQueryResult>('database.query', {
        workspaceId,
        connectionId,
        statement,
        confirmed,
      }),
    tableData: (workspaceId, connectionId, schema, table, offset = 0, limit = 200) =>
      invoke<DatabaseTableData>('database.tableData', {
        workspaceId,
        connectionId,
        schema,
        table,
        offset,
        limit,
      }),
    mutateRow: (
      workspaceId,
      connectionId,
      schema,
      table,
      mutation: DatabaseRowMutation,
      confirmed = false,
    ) =>
      invoke<DatabaseQueryResult>('database.mutateRow', {
        workspaceId,
        connectionId,
        schema,
        table,
        mutation,
        confirmed,
      }),
    history: (workspaceId, limit = 100) =>
      invoke<DatabaseHistoryEntry[]>('database.history', { workspaceId, limit }),
    clearHistory: (workspaceId, confirmed = false) =>
      invoke<void>('database.clearHistory', { workspaceId, confirmed }),
    exportResult: (
      workspaceId,
      connectionId,
      format,
      suggestedName,
      columns,
      rows: DatabaseValue[][],
    ) =>
      invoke<string | null>('database.exportResult', {
        workspaceId,
        connectionId,
        format,
        suggestedName,
        columns,
        rows,
      }),
    previewImport: (workspaceId) =>
      invoke<DatabaseImportPreview | null>('database.previewImport', { workspaceId }),
    applyImport: (workspaceId, connectionId, importId, schema, table, confirmed = false) =>
      invoke<DatabaseQueryResult>('database.applyImport', {
        workspaceId,
        connectionId,
        importId,
        schema,
        table,
        confirmed,
      }),
  },
  recommendations: {
    list: (workspaceId, source) =>
      invoke<Recommendation[]>('recommendations.list', { workspaceId, source }),
  },
  terminal: {
    create: (workspaceId, cols, rows) =>
      invoke<TerminalSession>('terminal.create', { workspaceId, cols, rows }),
    write: (terminalId, data) => invoke<void>('terminal.write', { terminalId, data }),
    resize: (terminalId, cols, rows) => invoke<void>('terminal.resize', { terminalId, cols, rows }),
    close: (terminalId) => invoke<void>('terminal.close', { terminalId }),
  },
  events: {
    subscribe: (name, listener) => {
      if (!allowedEvents.has(name)) return () => undefined;
      const channel = `forge:event:${name}`;
      const wrapped = (_event: Electron.IpcRendererEvent, payload: ForgeEventMap[typeof name]) =>
        listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    },
  },
};

contextBridge.exposeInMainWorld('forge', api);
