import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dialog, safeStorage, shell as electronShell, type BrowserWindow } from 'electron';
import {
  applicationSettingsSchema,
  layoutSchema,
  type GitOverview,
  type CommandEnvelope,
} from '../../shared/contracts.js';
import { DEFAULT_APPLICATION_SETTINGS, DEFAULT_LAYOUT } from '../../shared/defaults.js';
import { CommandBus } from '../core/commands.js';
import { openDatabase } from '../core/database.js';
import {
  DatabaseConnectionRepository,
  DatabaseHistoryRepository,
} from '../core/database-repositories.js';
import { DatabaseWorkbenchService } from '../core/database-workbench.js';
import { EventBus } from '../core/events.js';
import { AppError } from '../core/errors.js';
import { FileSystemService } from '../core/filesystem.js';
import { GitService } from '../core/git.js';
import { GitAdvisor } from '../core/git-advisor.js';
import { GitRiskPolicy, type GitRiskOperation } from '../core/git-risk.js';
import { Logger } from '../core/logger.js';
import { NotificationCenter } from '../core/notifications.js';
import { RecommendationEngine } from '../core/recommendations.js';
import { JsonSettingsRepository, WorkspaceRepository } from '../core/repositories.js';
import { SearchService } from '../core/search.js';
import { EncryptedSecretStore } from '../core/secrets.js';
import { TerminalManager } from '../core/terminal.js';
import { WorkspaceWatcher } from '../core/watcher.js';
import { WorkspaceService } from '../core/workspaces.js';

export async function createServices(
  userDataPath: string,
  getWindow: () => BrowserWindow | null,
  setDirtyCount: (count: number) => void,
) {
  await mkdir(userDataPath, { recursive: true });
  const logger = new Logger(
    join(userDataPath, 'logs', 'forge.log'),
    !process.env.NODE_ENV || process.env.NODE_ENV === 'development',
  );
  const database = openDatabase(join(userDataPath, 'forge.db'));
  const events = new EventBus(logger);
  const reportRecovery = (area: string) => {
    void logger.write('warning', 'application', 'settings.recovered', { area });
  };
  const workspaceRepository = new WorkspaceRepository(database, reportRecovery);
  const workspaces = new WorkspaceService(workspaceRepository, events);
  const settingsRepository = new JsonSettingsRepository(database, reportRecovery);
  const connectionRepository = new DatabaseConnectionRepository(database);
  const databaseHistory = new DatabaseHistoryRepository(database);
  const secretStore = new EncryptedSecretStore(database, {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptStringAsync(value),
    decrypt: async (value) => {
      const decrypted = await safeStorage.decryptStringAsync(value);
      return { value: decrypted.result, shouldReEncrypt: decrypted.shouldReEncrypt };
    },
  });
  const databaseWorkbench = new DatabaseWorkbenchService(
    workspaceRepository,
    connectionRepository,
    databaseHistory,
    secretStore,
  );
  const files = new FileSystemService(workspaceRepository, (path) => electronShell.trashItem(path));
  const search = new SearchService(workspaceRepository);
  const git = new GitService(workspaceRepository, (path) => electronShell.trashItem(path));
  const notifications = new NotificationCenter();
  const gitAdvisor = new GitAdvisor(new RecommendationEngine());
  const gitRisk = new GitRiskPolicy();
  const emitRendererEvent = (name: string, payload: unknown) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(`forge:event:${name}`, payload);
  };
  const watcher = new WorkspaceWatcher(
    (payload) => emitRendererEvent('file.changed', payload),
    logger,
  );
  const terminals = new TerminalManager(
    workspaceRepository,
    (payload) => emitRendererEvent('terminal.data', payload),
    (payload) => emitRendererEvent('terminal.exited', payload),
  );

  for (const name of [
    'workspace.opened',
    'workspace.closed',
    'workspace.settingsChanged',
    'application.settingsChanged',
    'git.changed',
    'database.changed',
    'recommendations.changed',
  ] as const) {
    events.subscribe(name, (event) => emitRendererEvent(name, event.payload));
  }

  const applicationSettings = () =>
    applicationSettingsSchema.parse(
      settingsRepository.get('general') ?? DEFAULT_APPLICATION_SETTINGS,
    );
  const publishGitChanged = async (
    workspaceId: string,
    repositoryPath: string,
    correlationId: string,
  ) => {
    await events.publish('git.changed', { workspaceId, repositoryPath }, correlationId);
  };
  const gitOverview = async (
    workspaceId: string,
    repositoryPath: string,
    correlationId: string,
  ): Promise<GitOverview> => {
    const [status, identity] = await Promise.all([
      git.status(workspaceId, repositoryPath),
      git.identity(workspaceId, repositoryPath),
    ]);
    const sensitiveFiles = await git.sensitiveFiles(
      workspaceId,
      repositoryPath,
      status.files,
      applicationSettings().gitSensitivePatterns,
    );
    const recommendations = gitAdvisor.advise({ repositoryPath, status, identity, sensitiveFiles });
    notifications.replace(workspaceId, 'git.advisor', recommendations);
    await events.publish(
      'recommendations.changed',
      { workspaceId, source: 'git.advisor' },
      correlationId,
    );
    return { status, identity, recommendations, sensitiveFiles };
  };
  const requireRiskConfirmation = async (
    operation: GitRiskOperation,
    workspaceId: string,
    repositoryPath: string,
    confirmed: boolean,
  ) => {
    const status = await git.status(workspaceId, repositoryPath);
    const risk = gitRisk.assess({
      operation,
      branch: status.branch,
      repository: repositoryPath || '.',
      dirty: status.dirty,
    });
    if (risk.requiresConfirmation && !confirmed) {
      throw new AppError(
        'GIT_CONFIRMATION_REQUIRED',
        `La operaciÃ³n ${operation} requiere confirmaciÃ³n explÃ­cita.`,
        risk.consequences,
        { operation, risk: risk.level, repository: repositoryPath || '.' },
      );
    }
  };

  const handler = async (command: CommandEnvelope, correlationId: string): Promise<unknown> => {
    switch (command.name) {
      case 'workspace.chooseAndOpen': {
        const window = getWindow();
        if (!window)
          throw new AppError('WINDOW_UNAVAILABLE', 'La ventana principal no está disponible.');
        const choice = await dialog.showOpenDialog(window, {
          properties: ['openDirectory'],
          title: 'Abrir workspace',
        });
        if (choice.canceled || !choice.filePaths[0]) return null;
        const workspace = await workspaces.openPath(choice.filePaths[0], correlationId);
        watcher.start(workspace.id, workspace.rootPath);
        return workspace;
      }
      case 'workspace.openRecent': {
        const workspace = await workspaces.openRecent(command.input.workspaceId, correlationId);
        watcher.start(workspace.id, workspace.rootPath);
        return workspace;
      }
      case 'workspace.close': {
        terminals.closeWorkspace(command.input.workspaceId);
        await databaseWorkbench.disconnectWorkspace(command.input.workspaceId);
        watcher.stop(command.input.workspaceId);
        notifications.clearWorkspace(command.input.workspaceId);
        return workspaces.close(command.input.workspaceId, correlationId);
      }
      case 'workspace.listRecent':
        return workspaces.listRecent(command.input.limit);
      case 'workspace.updateSettings':
        return workspaces.updateSettings(
          command.input.workspaceId,
          command.input.patch,
          correlationId,
        );
      case 'application.getSettings':
        return applicationSettingsSchema.parse(
          settingsRepository.get('general') ?? DEFAULT_APPLICATION_SETTINGS,
        );
      case 'application.updateSettings': {
        const current = applicationSettingsSchema.parse(
          settingsRepository.get('general') ?? DEFAULT_APPLICATION_SETTINGS,
        );
        const next = applicationSettingsSchema.parse({ ...current, ...command.input.patch });
        settingsRepository.set('general', next);
        await events.publish('application.settingsChanged', {}, correlationId);
        return next;
      }
      case 'application.setDirtyState':
        setDirtyCount(command.input.count);
        return undefined;
      case 'layout.get': {
        if (!workspaceRepository.findById(command.input.workspaceId))
          throw new AppError('WORKSPACE_NOT_FOUND', 'El workspace ya no está disponible.');
        return layoutSchema.parse(
          settingsRepository.getLayout(command.input.workspaceId) ?? DEFAULT_LAYOUT,
        );
      }
      case 'layout.save': {
        if (!workspaceRepository.findById(command.input.workspaceId))
          throw new AppError('WORKSPACE_NOT_FOUND', 'El workspace ya no está disponible.');
        settingsRepository.setLayout(command.input.workspaceId, command.input.layout);
        return undefined;
      }
      case 'file.list':
        return files.list(command.input.workspaceId, command.input.path);
      case 'file.read':
        return files.read(command.input.workspaceId, command.input.path);
      case 'file.write':
        return files.write(
          command.input.workspaceId,
          command.input.path,
          command.input.content,
          command.input.expectedVersion,
        );
      case 'file.createFile':
        return files.createFile(command.input.workspaceId, command.input.path);
      case 'file.createDirectory':
        return files.createDirectory(command.input.workspaceId, command.input.path);
      case 'file.rename':
        return files.rename(command.input.workspaceId, command.input.path, command.input.newName);
      case 'file.delete':
        return files.delete(command.input.workspaceId, command.input.path);
      case 'search.text':
        return search.text(
          command.input.workspaceId,
          command.input.query,
          command.input.caseSensitive,
        );
      case 'git.repositories':
        return git.repositories(command.input.workspaceId);
      case 'git.init': {
        const result = await git.initialize(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.initialBranch,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.status':
        return git.status(command.input.workspaceId, command.input.repositoryPath);
      case 'git.overview':
        return gitOverview(command.input.workspaceId, command.input.repositoryPath, correlationId);
      case 'git.identity':
        return git.identity(command.input.workspaceId, command.input.repositoryPath);
      case 'git.configureIdentity': {
        const result = await git.configureIdentity(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.name,
          command.input.email,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.diff':
        return git.diff(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.path,
          command.input.staged,
        );
      case 'git.stage': {
        const result = await git.stage(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.paths,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.unstage': {
        const result = await git.unstage(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.paths,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.discard': {
        await requireRiskConfirmation(
          'discard',
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.confirmed,
        );
        const result = await git.discard(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.paths,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.commit': {
        const overview = await gitOverview(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        const stagedSensitive = overview.sensitiveFiles.filter((file) => file.staged);
        if (stagedSensitive.length > 0 && !command.input.confirmSensitive) {
          throw new AppError(
            'GIT_SENSITIVE_FILES',
            'El commit incluye archivos con nombres potencialmente sensibles.',
            [
              ...stagedSensitive.map((file) => `${file.path} coincide con ${file.pattern}.`),
              'Revise el contenido o confirme explÃ­citamente el commit.',
            ],
            { fileCount: stagedSensitive.length },
          );
        }
        const result = await git.commit(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.message,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.branches':
        return git.branches(command.input.workspaceId, command.input.repositoryPath);
      case 'git.remotes':
        return git.remotes(command.input.workspaceId, command.input.repositoryPath);
      case 'git.setRemote': {
        const result = await git.setRemote(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.remote,
          command.input.url,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.createBranch': {
        const result = await git.createBranch(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.branch,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.checkout': {
        await requireRiskConfirmation(
          'checkout',
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.confirmed,
        );
        const result = await git.checkout(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.branch,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.merge': {
        await requireRiskConfirmation(
          'merge',
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.confirmed,
        );
        const result = await git.merge(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.branch,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.abortMerge': {
        const result = await git.abortMerge(
          command.input.workspaceId,
          command.input.repositoryPath,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.analyzeSync':
        return git.analyzeSync(command.input.workspaceId, command.input.repositoryPath);
      case 'git.integrateSync': {
        await requireRiskConfirmation(
          command.input.strategy,
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.confirmed,
        );
        try {
          const result = await git.integrateSync(
            command.input.workspaceId,
            command.input.repositoryPath,
            command.input.strategy,
          );
          await publishGitChanged(
            command.input.workspaceId,
            command.input.repositoryPath,
            correlationId,
          );
          return result;
        } catch (error) {
          await publishGitChanged(
            command.input.workspaceId,
            command.input.repositoryPath,
            correlationId,
          );
          throw error;
        }
      }
      case 'git.continueIntegration': {
        try {
          const result = await git.continueIntegration(
            command.input.workspaceId,
            command.input.repositoryPath,
          );
          await publishGitChanged(
            command.input.workspaceId,
            command.input.repositoryPath,
            correlationId,
          );
          return result;
        } catch (error) {
          await publishGitChanged(
            command.input.workspaceId,
            command.input.repositoryPath,
            correlationId,
          );
          throw error;
        }
      }
      case 'git.abortIntegration': {
        if (!command.input.confirmed) {
          throw new AppError(
            'GIT_CONFIRMATION_REQUIRED',
            'Cancelar la integración requiere confirmación explícita.',
            ['Se restaurará el estado anterior al merge o rebase.'],
          );
        }
        const result = await git.abortIntegration(
          command.input.workspaceId,
          command.input.repositoryPath,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.stash': {
        if (!command.input.confirmed) {
          throw new AppError(
            'GIT_CONFIRMATION_REQUIRED',
            'Guardar temporalmente los cambios requiere confirmación explícita.',
            ['Se incluirán cambios rastreados y archivos nuevos en una entrada de stash.'],
          );
        }
        const result = await git.stash(command.input.workspaceId, command.input.repositoryPath);
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'git.fetch': {
        const result = await git.fetch(command.input.workspaceId, command.input.repositoryPath);
        await events.publish(
          'git.changed',
          {
            workspaceId: command.input.workspaceId,
            repositoryPath: command.input.repositoryPath,
          },
          correlationId,
        );
        return result;
      }
      case 'git.pull': {
        await requireRiskConfirmation(
          'pull',
          command.input.workspaceId,
          command.input.repositoryPath,
          false,
        );
        const result = await git.pull(command.input.workspaceId, command.input.repositoryPath);
        await events.publish(
          'git.changed',
          {
            workspaceId: command.input.workspaceId,
            repositoryPath: command.input.repositoryPath,
          },
          correlationId,
        );
        return result;
      }
      case 'git.push': {
        const result = await git.push(command.input.workspaceId, command.input.repositoryPath);
        await events.publish(
          'git.changed',
          {
            workspaceId: command.input.workspaceId,
            repositoryPath: command.input.repositoryPath,
          },
          correlationId,
        );
        return result;
      }
      case 'git.history':
        return git.history(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.limit,
        );
      case 'git.show':
        return git.show(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.commit,
        );
      case 'git.conflict':
        return git.conflict(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.path,
        );
      case 'git.resolveConflict': {
        const result = await git.resolveConflict(
          command.input.workspaceId,
          command.input.repositoryPath,
          command.input.path,
          command.input.content,
          command.input.expectedVersion,
        );
        await publishGitChanged(
          command.input.workspaceId,
          command.input.repositoryPath,
          correlationId,
        );
        return result;
      }
      case 'github.info':
        return git.githubInfo(command.input.workspaceId, command.input.repositoryPath);
      case 'github.openRepository': {
        const github = await git.githubInfo(
          command.input.workspaceId,
          command.input.repositoryPath,
        );
        if (!github) {
          throw new AppError(
            'GITHUB_REMOTE_NOT_FOUND',
            'El repositorio no tiene un remoto válido de GitHub.',
          );
        }
        const url = new URL(github.webUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
          throw new AppError('EXTERNAL_URL_BLOCKED', 'La URL externa no está permitida.');
        }
        await electronShell.openExternal(url.toString());
        return undefined;
      }
      case 'database.listConnections':
        return databaseWorkbench.listConnections(command.input.workspaceId);
      case 'database.saveConnection': {
        const profile = await databaseWorkbench.saveConnection(
          command.input.workspaceId,
          command.input.connectionId,
          command.input.profile,
          command.input.password,
        );
        await events.publish(
          'database.changed',
          { workspaceId: command.input.workspaceId, connectionId: profile.id },
          correlationId,
        );
        return profile;
      }
      case 'database.deleteConnection': {
        await databaseWorkbench.deleteConnection(
          command.input.workspaceId,
          command.input.connectionId,
          command.input.confirmed,
        );
        await events.publish(
          'database.changed',
          {
            workspaceId: command.input.workspaceId,
            connectionId: command.input.connectionId,
          },
          correlationId,
        );
        return undefined;
      }
      case 'database.testConnection':
        return databaseWorkbench.testConnection(
          command.input.workspaceId,
          command.input.profile,
          command.input.password,
        );
      case 'database.connect': {
        const profile = await databaseWorkbench.connect(
          command.input.workspaceId,
          command.input.connectionId,
        );
        await events.publish(
          'database.changed',
          {
            workspaceId: command.input.workspaceId,
            connectionId: command.input.connectionId,
          },
          correlationId,
        );
        return profile;
      }
      case 'database.disconnect': {
        await databaseWorkbench.disconnect(command.input.workspaceId, command.input.connectionId);
        await events.publish(
          'database.changed',
          {
            workspaceId: command.input.workspaceId,
            connectionId: command.input.connectionId,
          },
          correlationId,
        );
        return undefined;
      }
      case 'database.catalog':
        return databaseWorkbench.catalog(command.input.workspaceId, command.input.connectionId);
      case 'database.structure':
        return databaseWorkbench.structure(
          command.input.workspaceId,
          command.input.connectionId,
          command.input.schema,
          command.input.table,
        );
      case 'database.query':
        return databaseWorkbench.query(
          command.input.workspaceId,
          command.input.connectionId,
          command.input.statement,
          command.input.confirmed,
        );
      case 'database.tableData':
        return databaseWorkbench.tableData(
          command.input.workspaceId,
          command.input.connectionId,
          command.input.schema,
          command.input.table,
          command.input.offset,
          command.input.limit,
        );
      case 'database.mutateRow':
        return databaseWorkbench.mutateRow(
          command.input.workspaceId,
          command.input.connectionId,
          command.input.schema,
          command.input.table,
          command.input.mutation,
          command.input.confirmed,
        );
      case 'database.history':
        return databaseWorkbench.history(command.input.workspaceId, command.input.limit);
      case 'database.clearHistory':
        return databaseWorkbench.clearHistory(command.input.workspaceId, command.input.confirmed);
      case 'database.exportResult': {
        const window = getWindow();
        if (!window)
          throw new AppError('WINDOW_UNAVAILABLE', 'La ventana principal no está disponible.');
        const safeName = [...command.input.suggestedName]
          .map((character) =>
            '<>:"/\\|?*'.includes(character) || character.charCodeAt(0) < 32 ? '_' : character,
          )
          .join('');
        const choice = await dialog.showSaveDialog(window, {
          title: 'Exportar resultado',
          defaultPath: `${safeName}.${command.input.format}`,
          filters:
            command.input.format === 'json'
              ? [{ name: 'JSON', extensions: ['json'] }]
              : [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (choice.canceled || !choice.filePath) return null;
        await databaseWorkbench.exportResult(
          command.input.workspaceId,
          command.input.connectionId,
          command.input.format,
          command.input.columns,
          command.input.rows,
          choice.filePath,
        );
        return choice.filePath;
      }
      case 'database.previewImport': {
        const window = getWindow();
        if (!window)
          throw new AppError('WINDOW_UNAVAILABLE', 'La ventana principal no está disponible.');
        const choice = await dialog.showOpenDialog(window, {
          title: 'Importar datos',
          properties: ['openFile'],
          filters: [
            { name: 'Datos CSV o JSON', extensions: ['csv', 'json'] },
            { name: 'Todos los archivos', extensions: ['*'] },
          ],
        });
        if (choice.canceled || !choice.filePaths[0]) return null;
        return databaseWorkbench.previewImport(command.input.workspaceId, choice.filePaths[0]);
      }
      case 'database.applyImport':
        return databaseWorkbench.applyImport(
          command.input.workspaceId,
          command.input.connectionId,
          command.input.importId,
          command.input.schema,
          command.input.table,
          command.input.confirmed,
        );
      case 'recommendations.list':
        if (!workspaceRepository.findById(command.input.workspaceId)) {
          throw new AppError('WORKSPACE_NOT_FOUND', 'El workspace ya no estÃ¡ disponible.');
        }
        return notifications.list(command.input.workspaceId, command.input.source);
      case 'terminal.create':
        return terminals.create(command.input.workspaceId, command.input.cols, command.input.rows);
      case 'terminal.write':
        return terminals.write(command.input.terminalId, command.input.data);
      case 'terminal.resize':
        return terminals.resize(command.input.terminalId, command.input.cols, command.input.rows);
      case 'terminal.close':
        return terminals.close(command.input.terminalId);
    }
  };
  return {
    commandBus: new CommandBus(handler, logger),
    database,
    logger,
    dispose: () => {
      watcher.dispose();
      terminals.dispose();
      void databaseWorkbench.dispose();
      database.close();
    },
  };
}
