import { watch, type FSWatcher } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { ForgeEventMap } from '../../shared/contracts.js';
import type { Logger } from './logger.js';

type FileChange = ForgeEventMap['file.changed'];

export class WorkspaceWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly onChange: (change: FileChange) => void,
    private readonly logger: Logger,
  ) {}

  start(workspaceId: string, rootPath: string): void {
    this.stop(workspaceId);
    try {
      const watcher = watch(rootPath, { recursive: true }, (eventType, fileName) => {
        if (!fileName) return;
        const path = fileName.toString().split('\\').join('/');
        const key = `${workspaceId}:${path}`;
        const existing = this.pending.get(key);
        if (existing) clearTimeout(existing);
        this.pending.set(
          key,
          setTimeout(() => {
            this.pending.delete(key);
            void this.emitChange(workspaceId, rootPath, path, eventType);
          }, 120),
        );
      });
      watcher.on('error', () => {
        void this.logger.write('warning', 'filesystem', 'watcher.failed', { workspaceId });
      });
      this.watchers.set(workspaceId, watcher);
    } catch {
      void this.logger.write('warning', 'filesystem', 'watcher.unavailable', { workspaceId });
    }
  }

  stop(workspaceId: string): void {
    this.watchers.get(workspaceId)?.close();
    this.watchers.delete(workspaceId);
    const prefix = `${workspaceId}:`;
    for (const [key, timeout] of this.pending) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timeout);
      this.pending.delete(key);
    }
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    this.watchers.clear();
    this.pending.clear();
  }

  private async emitChange(
    workspaceId: string,
    rootPath: string,
    path: string,
    eventType: string,
  ): Promise<void> {
    let exists = true;
    await access(join(rootPath, path)).catch(() => {
      exists = false;
    });
    const kind: FileChange['kind'] =
      eventType === 'change' ? 'changed' : exists ? 'created' : 'deleted';
    this.onChange({ workspaceId, path, kind });
  }
}
