import { randomUUID } from 'node:crypto';
import type { ForgeError } from '../../shared/contracts.js';

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remediation?: string[],
    readonly safeDetails?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function normalizeError(error: unknown, correlationId = randomUUID()): ForgeError {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      correlationId,
      ...(error.remediation ? { remediation: error.remediation } : {}),
      ...(error.safeDetails ? { details: error.safeDetails } : {}),
    };
  }
  const systemError = error as NodeJS.ErrnoException;
  const filesystemErrors: Record<
    string,
    { code: string; message: string; remediation?: string[] }
  > = {
    EACCES: {
      code: 'FILE_ACCESS_DENIED',
      message: 'Windows denegó el acceso al archivo o carpeta.',
      remediation: [
        'Compruebe los permisos del elemento.',
        'Cierre otras aplicaciones que puedan bloquearlo.',
      ],
    },
    EPERM: {
      code: 'FILE_ACCESS_DENIED',
      message: 'Windows no permitió completar la operación.',
      remediation: [
        'Compruebe los permisos del elemento.',
        'Cierre otras aplicaciones que puedan bloquearlo.',
      ],
    },
    EEXIST: {
      code: 'FILE_ALREADY_EXISTS',
      message: 'Ya existe un archivo o carpeta con ese nombre.',
    },
    ENOENT: { code: 'FILE_NOT_FOUND', message: 'El archivo o carpeta ya no existe.' },
    ENOSPC: {
      code: 'DISK_FULL',
      message: 'No hay espacio suficiente en el disco para completar la operación.',
    },
    EBUSY: {
      code: 'FILE_BUSY',
      message: 'El archivo o carpeta está siendo utilizado por otra aplicación.',
    },
    ENOTEMPTY: { code: 'DIRECTORY_NOT_EMPTY', message: 'La carpeta no está vacía.' },
  };
  const safe = systemError.code ? filesystemErrors[systemError.code] : undefined;
  if (safe) {
    return {
      code: safe.code,
      message: safe.message,
      correlationId,
      ...(safe.remediation ? { remediation: safe.remediation } : {}),
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'Forge no pudo completar la operación.',
    remediation: ['Inténtelo nuevamente.', 'Consulte los logs usando el identificador del error.'],
    correlationId,
  };
}
