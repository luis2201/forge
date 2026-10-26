import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const SENSITIVE_KEY = /password|passwd|secret|token|authorization|cookie|private.?key|api.?key/i;
const MAX_LOG_SIZE = 2 * 1024 * 1024;

export function redact(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value
      .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1[REDACTED]@')
      .replace(/(oauth2:|x-access-token:)[^@\s]+/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, childKey),
      ]),
    );
  }
  return value;
}

export class Logger {
  constructor(
    private readonly filePath: string,
    private readonly development = false,
  ) {}

  async write(
    level: 'debug' | 'info' | 'warning' | 'error',
    category: string,
    event: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await this.rotateIfNeeded();
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        category,
        event,
        metadata: redact(metadata),
      });
      await appendFile(this.filePath, `${line}\n`, 'utf8');
      if (this.development) console[level === 'warning' ? 'warn' : level](line);
    } catch {
      // Logging must never crash the application or recursively log its own failure.
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      if ((await stat(this.filePath)).size >= MAX_LOG_SIZE) {
        await rename(this.filePath, `${this.filePath}.1`).catch(() => undefined);
      }
    } catch {
      // File does not exist yet.
    }
  }
}
