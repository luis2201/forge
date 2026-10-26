import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { SearchResponse, SearchResult } from '../../shared/contracts.js';
import { AppError } from './errors.js';
import type { WorkspaceRepository } from './repositories.js';

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'release', 'coverage']);
const MAX_FILES = 5_000;
const MAX_RESULTS = 200;
const MAX_SEARCH_FILE_SIZE = 1024 * 1024;

export class SearchService {
  constructor(private readonly workspaces: WorkspaceRepository) {}

  async text(workspaceId: string, query: string, caseSensitive: boolean): Promise<SearchResponse> {
    const workspace = this.workspaces.findById(workspaceId);
    if (!workspace)
      throw new AppError('WORKSPACE_NOT_FOUND', 'El workspace ya no está disponible.');
    const results: SearchResult[] = [];
    let filesScanned = 0;
    let truncated = false;
    const needle = caseSensitive ? query : query.toLocaleLowerCase();

    const visit = async (directory: string): Promise<void> => {
      if (truncated) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (truncated) return;
        const absolute = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        filesScanned += 1;
        if (filesScanned > MAX_FILES) {
          truncated = true;
          return;
        }
        const info = await stat(absolute);
        if (info.size > MAX_SEARCH_FILE_SIZE) continue;
        const buffer = await readFile(absolute);
        if (buffer.subarray(0, 8_192).includes(0)) continue;
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? '';
          const haystack = caseSensitive ? line : line.toLocaleLowerCase();
          const column = haystack.indexOf(needle);
          if (column === -1) continue;
          results.push({
            path: relative(workspace.rootPath, absolute).split('\\').join('/'),
            line: index + 1,
            column: column + 1,
            preview: line.trim().slice(0, 300),
          });
          if (results.length >= MAX_RESULTS) {
            truncated = true;
            return;
          }
        }
      }
    };

    await visit(workspace.rootPath);
    return { results, filesScanned, truncated };
  }
}
