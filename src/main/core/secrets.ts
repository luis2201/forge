import type Database from 'better-sqlite3';
import { AppError } from './errors.js';

export interface SecretProtector {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<{ value: string; shouldReEncrypt: boolean }>;
}

export interface SecretStore {
  set(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<void>;
  has(ref: string): boolean;
}

export class EncryptedSecretStore implements SecretStore {
  constructor(
    private readonly db: Database.Database,
    private readonly protector: SecretProtector,
  ) {}

  async set(ref: string, value: string): Promise<void> {
    await this.requireProtection();
    const encrypted = await this.protector.encrypt(value);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO secret_values(ref, encrypted_value, created_at, updated_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET encrypted_value=excluded.encrypted_value, updated_at=excluded.updated_at`,
      )
      .run(ref, encrypted, now, now);
  }

  async get(ref: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT encrypted_value FROM secret_values WHERE ref=?')
      .get(ref) as { encrypted_value: Buffer } | undefined;
    if (!row) return null;
    await this.requireProtection();
    try {
      const decrypted = await this.protector.decrypt(row.encrypted_value);
      if (decrypted.shouldReEncrypt) await this.set(ref, decrypted.value);
      return decrypted.value;
    } catch {
      throw new AppError(
        'SECRET_UNAVAILABLE',
        'Windows no pudo desbloquear la credencial guardada.',
        [
          'Compruebe que utiliza la misma cuenta de Windows con la que guardó la conexión.',
          'Edite la conexión e ingrese nuevamente la contraseña.',
        ],
      );
    }
  }

  delete(ref: string): Promise<void> {
    this.db.prepare('DELETE FROM secret_values WHERE ref=?').run(ref);
    return Promise.resolve();
  }

  has(ref: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM secret_values WHERE ref=?').get(ref));
  }

  private async requireProtection(): Promise<void> {
    if (await this.protector.available()) return;
    throw new AppError(
      'SECRET_STORAGE_UNAVAILABLE',
      'El cifrado seguro del sistema operativo no está disponible.',
      [
        'Desbloquee la sesión de Windows e inténtelo nuevamente.',
        'Forge no guardará la contraseña sin protección del sistema.',
      ],
    );
  }
}
