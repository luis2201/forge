import { describe, expect, it } from 'vitest';
import { AppError, normalizeError } from '../../src/main/core/errors';

describe('normalizeError', () => {
  it('preserves only explicitly safe application details', () => {
    const result = normalizeError(
      new AppError('NO_ACCESS', 'Sin acceso.', ['Revise permisos.'], { resource: 'workspace' }),
    );
    expect(result).toMatchObject({
      code: 'NO_ACCESS',
      message: 'Sin acceso.',
      details: { resource: 'workspace' },
    });
    expect(result.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not expose unknown errors', () => {
    const result = normalizeError(new Error('token=super-secret'));
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(result.code).toBe('INTERNAL_ERROR');
  });
});
