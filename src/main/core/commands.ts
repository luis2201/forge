import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import {
  commandEnvelopeSchema,
  type CommandEnvelope,
  type Result,
} from '../../shared/contracts.js';
import { AppError, normalizeError } from './errors.js';
import type { Logger } from './logger.js';

export type CommandHandler = (command: CommandEnvelope, correlationId: string) => Promise<unknown>;

export class CommandBus {
  constructor(
    private readonly handler: CommandHandler,
    private readonly logger: Logger,
  ) {}

  async execute(payload: unknown): Promise<Result<unknown>> {
    const correlationId = randomUUID();
    const startedAt = performance.now();
    try {
      const command = commandEnvelopeSchema.parse(payload);
      const value = await this.handler(command, correlationId);
      await this.logger.write('info', 'application', 'command.completed', {
        name: command.name,
        correlationId,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return { ok: true, value };
    } catch (error) {
      const safeError = normalizeError(
        error instanceof ZodError
          ? new AppError('INVALID_COMMAND', 'La solicitud no tiene un formato válido.')
          : error,
        correlationId,
      );
      await this.logger.write('error', 'application', 'command.failed', {
        code: safeError.code,
        correlationId,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return { ok: false, error: safeError };
    }
  }
}
