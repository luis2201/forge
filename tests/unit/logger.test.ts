import { describe, expect, it } from 'vitest';
import { redact } from '../../src/main/core/logger';

describe('log redaction', () => {
  it('redacts nested sensitive values without mutating safe metadata', () => {
    expect(
      redact({ username: 'luis', password: 'unsafe', nested: { apiToken: '123', port: 3306 } }),
    ).toEqual({
      username: 'luis',
      password: '[REDACTED]',
      nested: { apiToken: '[REDACTED]', port: 3306 },
    });
  });

  it('redacts credentials embedded in remote URLs even under a generic key', () => {
    const result = JSON.stringify(
      redact({ remote: 'https://secret-token@github.com/acme/repo.git' }),
    );
    expect(result).not.toContain('secret-token');
    expect(result).toContain('[REDACTED]');
  });
});
