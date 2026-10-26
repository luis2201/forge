import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { DEFAULT_WORKSPACE_SETTINGS } from '../../shared/defaults.js';
import {
  workspaceSettingsSchema,
  type Workspace,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
} from '../../shared/contracts.js';
import { AppError } from './errors.js';
import type { EventBus } from './events.js';
import type { WorkspaceRepository } from './repositories.js';

export async function canonicalizeDirectory(folderPath: string): Promise<string> {
  if (!isAbsolute(folderPath))
    throw new AppError('PATH_NOT_ABSOLUTE', 'La carpeta seleccionada no es una ruta absoluta.');
  try {
    const canonical = await realpath(resolve(folderPath));
    if (!(await stat(canonical)).isDirectory())
      throw new AppError('PATH_NOT_DIRECTORY', 'La ruta seleccionada no es una carpeta.');
    return canonical;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'WORKSPACE_UNAVAILABLE',
      'No fue posible acceder a la carpeta del workspace.',
      ['Compruebe que la carpeta existe.', 'Verifique sus permisos de acceso.'],
    );
  }
}

export async function assertPathInside(rootPath: string, candidatePath: string): Promise<string> {
  const [root, candidate] = await Promise.all([realpath(rootPath), realpath(candidatePath)]);
  const child = relative(root, candidate);
  if (child === '' || (!child.startsWith('..') && !isAbsolute(child))) return candidate;
  throw new AppError(
    'PATH_OUTSIDE_WORKSPACE',
    'La operación intenta acceder fuera del workspace autorizado.',
  );
}

export class WorkspaceService {
  constructor(
    private readonly repository: WorkspaceRepository,
    private readonly events: EventBus,
  ) {}

  async openPath(folderPath: string, correlationId: string): Promise<Workspace> {
    const canonicalPath = await canonicalizeDirectory(folderPath);
    let workspace = this.repository.findByPath(canonicalPath);
    const now = new Date();
    if (!workspace) {
      workspace = {
        id: randomUUID(),
        name: basename(canonicalPath),
        rootPath: canonicalPath,
        environment: DEFAULT_WORKSPACE_SETTINGS.environment,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastOpenedAt: now.toISOString(),
      };
      this.repository.create(workspace);
    } else {
      this.repository.touch(workspace.id, now.getTime());
      workspace = { ...workspace, updatedAt: now.toISOString(), lastOpenedAt: now.toISOString() };
    }
    await this.events.publish('workspace.opened', { workspaceId: workspace.id }, correlationId);
    return workspace;
  }

  async openRecent(id: string, correlationId: string): Promise<Workspace> {
    const workspace = this.repository.findById(id);
    if (!workspace)
      throw new AppError('WORKSPACE_NOT_FOUND', 'El workspace ya no está disponible.');
    return this.openPath(workspace.rootPath, correlationId);
  }

  listRecent(limit: number): Workspace[] {
    return this.repository.listRecent(limit);
  }

  async close(id: string, correlationId: string): Promise<void> {
    if (!this.repository.findById(id))
      throw new AppError('WORKSPACE_NOT_FOUND', 'El workspace ya no está disponible.');
    await this.events.publish('workspace.closed', { workspaceId: id }, correlationId);
  }

  async updateSettings(
    id: string,
    patch: WorkspaceSettingsPatch,
    correlationId: string,
  ): Promise<WorkspaceSettings> {
    const current = this.repository.getSettings(id);
    if (!current) throw new AppError('WORKSPACE_NOT_FOUND', 'El workspace ya no está disponible.');
    const settings = workspaceSettingsSchema.parse({ ...current, ...patch });
    this.repository.saveSettings(id, settings);
    await this.events.publish('workspace.settingsChanged', { workspaceId: id }, correlationId);
    return settings;
  }
}
