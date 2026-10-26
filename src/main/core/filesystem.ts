import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FileDocument, FileEntry, FileMutation } from '../../shared/contracts.js';
import { AppError } from './errors.js';
import type { WorkspaceRepository } from './repositories.js';

const MAX_READ_BYTES = 5 * 1024 * 1024;
const INVALID_WINDOWS_NAME = /[<>:"/\\|?*]/;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function publicPath(value: string): string {
  return value.split('\\').join('/');
}

export function normalizeRelativePath(value: string, allowRoot = false): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized === '' && allowRoot) return '';
  if (
    normalized === '' ||
    isAbsolute(normalized) ||
    win32.isAbsolute(normalized) ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new AppError('INVALID_PATH', 'La ruta solicitada no es válida.');
  }
  return normalized;
}

export function validateFileName(value: string): string {
  const name = value.trim();
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.endsWith('.') ||
    name.endsWith(' ') ||
    [...name].some((character) => character.charCodeAt(0) < 32) ||
    INVALID_WINDOWS_NAME.test(name) ||
    RESERVED_WINDOWS_NAME.test(name)
  ) {
    throw new AppError('INVALID_FILE_NAME', 'El nombre no es válido para Windows.');
  }
  return name;
}

function ensureInside(root: string, candidate: string): void {
  const child = relative(root, candidate);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new AppError(
      'PATH_OUTSIDE_WORKSPACE',
      'La operación intenta acceder fuera del workspace autorizado.',
    );
  }
}

async function contentVersion(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return `sha256:${hash.digest('hex')}`;
}

export class FileSystemService {
  constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly moveToTrash: (absolutePath: string) => Promise<void>,
  ) {}

  async list(workspaceId: string, requestedPath: string): Promise<FileEntry[]> {
    const { root, absolute } = await this.resolveExisting(workspaceId, requestedPath, true);
    if (!(await stat(absolute)).isDirectory()) {
      throw new AppError('NOT_A_DIRECTORY', 'La ruta solicitada no es una carpeta.');
    }
    const items = await readdir(absolute, { withFileTypes: true });
    const entries = await Promise.all(
      items.slice(0, 5_000).map(async (item): Promise<FileEntry> => {
        const itemPath = join(absolute, item.name);
        const info = await lstat(itemPath);
        const type = item.isSymbolicLink() ? 'symlink' : item.isDirectory() ? 'directory' : 'file';
        return {
          name: item.name,
          path: publicPath(relative(root, itemPath)),
          type,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        };
      }),
    );
    return entries.sort((left, right) => {
      const leftRank = left.type === 'directory' ? 0 : left.type === 'symlink' ? 1 : 2;
      const rightRank = right.type === 'directory' ? 0 : right.type === 'symlink' ? 1 : 2;
      return (
        leftRank - rightRank ||
        left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      );
    });
  }

  async read(workspaceId: string, requestedPath: string): Promise<FileDocument> {
    const { absolute, relativePath } = await this.resolveExisting(workspaceId, requestedPath);
    const info = await stat(absolute);
    if (!info.isFile()) throw new AppError('NOT_A_FILE', 'La ruta solicitada no es un archivo.');
    if (info.size > MAX_READ_BYTES) {
      throw new AppError('FILE_TOO_LARGE', 'El archivo supera el límite de 5 MB del editor.', [
        'Utilice una herramienta especializada para archivos grandes.',
      ]);
    }
    const buffer = await readFile(absolute);
    if (buffer.subarray(0, 8_192).includes(0)) {
      throw new AppError('BINARY_FILE', 'Forge no puede abrir archivos binarios en el editor.');
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new AppError('UNSUPPORTED_ENCODING', 'El archivo no utiliza codificación UTF-8.', [
        'Convierta el archivo a UTF-8 antes de editarlo.',
      ]);
    }
    return {
      path: relativePath,
      content,
      version: await contentVersion(absolute),
      size: info.size,
    };
  }

  async write(
    workspaceId: string,
    requestedPath: string,
    content: string,
    expectedVersion: string,
  ): Promise<FileMutation> {
    if (Buffer.byteLength(content, 'utf8') > MAX_READ_BYTES) {
      throw new AppError('FILE_TOO_LARGE', 'El contenido supera el límite de 5 MB del editor.');
    }
    const { absolute, relativePath } = await this.resolveExisting(workspaceId, requestedPath);
    const before = await stat(absolute);
    if (!before.isFile()) throw new AppError('NOT_A_FILE', 'La ruta solicitada no es un archivo.');
    if ((await contentVersion(absolute)) !== expectedVersion) {
      throw new AppError('FILE_MODIFIED_EXTERNALLY', 'El archivo cambió fuera de Forge.', [
        'Revise los cambios externos antes de sobrescribirlos.',
      ]);
    }
    const temporary = join(dirname(absolute), `.forge-save-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: before.mode });
      await rename(temporary, absolute);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    const after = await stat(absolute);
    return {
      path: relativePath,
      version: await contentVersion(absolute),
      modifiedAt: after.mtime.toISOString(),
    };
  }

  async createFile(workspaceId: string, requestedPath: string): Promise<FileMutation> {
    const target = await this.resolveNew(workspaceId, requestedPath);
    const handle = await open(target.absolute, 'wx');
    await handle.close();
    const info = await stat(target.absolute);
    return {
      path: target.relativePath,
      version: await contentVersion(target.absolute),
      modifiedAt: info.mtime.toISOString(),
    };
  }

  async createDirectory(workspaceId: string, requestedPath: string): Promise<void> {
    const target = await this.resolveNew(workspaceId, requestedPath);
    await mkdir(target.absolute);
  }

  async rename(workspaceId: string, requestedPath: string, requestedName: string): Promise<string> {
    const source = await this.resolveEntry(workspaceId, requestedPath, true);
    if (source.relativePath === '')
      throw new AppError(
        'WORKSPACE_ROOT_PROTECTED',
        'No se puede renombrar la raíz del workspace.',
      );
    const name = validateFileName(requestedName);
    const target = join(dirname(source.absolute), name);
    ensureInside(source.root, target);
    await access(target).then(
      () => {
        throw new AppError('FILE_ALREADY_EXISTS', 'Ya existe un elemento con ese nombre.');
      },
      () => undefined,
    );
    await rename(source.absolute, target);
    return publicPath(relative(source.root, target));
  }

  async delete(workspaceId: string, requestedPath: string): Promise<void> {
    const target = await this.resolveEntry(workspaceId, requestedPath, true);
    if (target.relativePath === '')
      throw new AppError('WORKSPACE_ROOT_PROTECTED', 'No se puede eliminar la raíz del workspace.');
    await this.moveToTrash(target.absolute);
  }

  private getRoot(workspaceId: string): string {
    const workspace = this.workspaces.findById(workspaceId);
    if (!workspace)
      throw new AppError('WORKSPACE_NOT_FOUND', 'El workspace ya no está disponible.');
    return workspace.rootPath;
  }

  private async resolveExisting(workspaceId: string, requestedPath: string, allowRoot = false) {
    const normalized = normalizeRelativePath(requestedPath, allowRoot);
    const root = await realpath(this.getRoot(workspaceId));
    const candidate = normalized === '' ? root : resolve(root, ...normalized.split('/'));
    ensureInside(root, candidate);
    let absolute: string;
    try {
      absolute = await realpath(candidate);
    } catch {
      throw new AppError('FILE_NOT_FOUND', 'El archivo o carpeta ya no existe.');
    }
    ensureInside(root, absolute);
    return { root, absolute, relativePath: publicPath(relative(root, candidate)) };
  }

  private async resolveNew(workspaceId: string, requestedPath: string) {
    const normalized = normalizeRelativePath(requestedPath);
    const root = await realpath(this.getRoot(workspaceId));
    const segments = normalized.split('/');
    validateFileName(segments.at(-1) ?? '');
    const target = resolve(root, ...segments);
    ensureInside(root, target);
    const parent = await realpath(dirname(target));
    ensureInside(root, parent);
    return { root, absolute: join(parent, basename(target)), relativePath: normalized };
  }

  private async resolveEntry(workspaceId: string, requestedPath: string, allowRoot = false) {
    const normalized = normalizeRelativePath(requestedPath, allowRoot);
    const root = await realpath(this.getRoot(workspaceId));
    const candidate = normalized === '' ? root : resolve(root, ...normalized.split('/'));
    ensureInside(root, candidate);
    if (candidate === root) return { root, absolute: root, relativePath: '' };
    const parent = await realpath(dirname(candidate));
    ensureInside(root, parent);
    try {
      await lstat(candidate);
    } catch {
      throw new AppError('FILE_NOT_FOUND', 'El archivo o carpeta ya no existe.');
    }
    return { root, absolute: candidate, relativePath: normalized };
  }
}
