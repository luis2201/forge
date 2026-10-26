import type Database from 'better-sqlite3';
import type { Workspace, WorkspaceLayout, WorkspaceSettings } from '../../shared/contracts.js';
import { workspaceSettingsSchema } from '../../shared/contracts.js';
import { DEFAULT_WORKSPACE_SETTINGS } from '../../shared/defaults.js';

type WorkspaceRow = {
  id: string;
  name: string;
  canonical_path: string;
  created_at: number;
  updated_at: number;
  last_opened_at: number | null;
  settings_json: string;
};

const iso = (value: number): string => new Date(value).toISOString();

export class WorkspaceRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly onRecovery: (area: string) => void = () => undefined,
  ) {}

  findByPath(canonicalPath: string): Workspace | null {
    const row = this.db
      .prepare(
        `SELECT w.*, r.canonical_path, s.settings_json FROM workspaces w JOIN workspace_roots r ON r.workspace_id=w.id JOIN workspace_settings s ON s.workspace_id=w.id WHERE r.canonical_path=? COLLATE NOCASE AND w.is_archived=0`,
      )
      .get(canonicalPath) as WorkspaceRow | undefined;
    return row ? this.map(row) : null;
  }

  findById(id: string): Workspace | null {
    const row = this.db
      .prepare(
        `SELECT w.*, r.canonical_path, s.settings_json FROM workspaces w JOIN workspace_roots r ON r.workspace_id=w.id JOIN workspace_settings s ON s.workspace_id=w.id WHERE w.id=? AND w.is_archived=0`,
      )
      .get(id) as WorkspaceRow | undefined;
    return row ? this.map(row) : null;
  }

  create(workspace: Workspace): void {
    const created = Date.parse(workspace.createdAt);
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO workspaces(id,name,created_at,updated_at,last_opened_at) VALUES(?,?,?,?,?)',
        )
        .run(
          workspace.id,
          workspace.name,
          created,
          Date.parse(workspace.updatedAt),
          workspace.lastOpenedAt ? Date.parse(workspace.lastOpenedAt) : null,
        );
      this.db
        .prepare(
          'INSERT INTO workspace_roots(id,workspace_id,canonical_path,display_path,created_at) VALUES(?,?,?,?,?)',
        )
        .run(crypto.randomUUID(), workspace.id, workspace.rootPath, workspace.rootPath, created);
      this.db
        .prepare(
          'INSERT INTO workspace_settings(workspace_id,schema_version,settings_json,updated_at) VALUES(?,1,?,?)',
        )
        .run(workspace.id, JSON.stringify({ environment: workspace.environment }), created);
    })();
  }

  touch(id: string, timestamp: number): void {
    this.db
      .prepare('UPDATE workspaces SET last_opened_at=?, updated_at=? WHERE id=?')
      .run(timestamp, timestamp, id);
  }

  listRecent(limit: number): Workspace[] {
    return (
      this.db
        .prepare(
          `SELECT w.*, r.canonical_path, s.settings_json FROM workspaces w JOIN workspace_roots r ON r.workspace_id=w.id JOIN workspace_settings s ON s.workspace_id=w.id WHERE w.is_archived=0 ORDER BY w.last_opened_at DESC LIMIT ?`,
        )
        .all(limit) as WorkspaceRow[]
    ).map((row) => this.map(row));
  }

  getSettings(id: string): WorkspaceSettings | null {
    const row = this.db
      .prepare('SELECT settings_json FROM workspace_settings WHERE workspace_id=?')
      .get(id) as { settings_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = workspaceSettingsSchema.safeParse(JSON.parse(row.settings_json));
      return parsed.success ? parsed.data : DEFAULT_WORKSPACE_SETTINGS;
    } catch {
      this.onRecovery('workspace.settings');
      return DEFAULT_WORKSPACE_SETTINGS;
    }
  }

  saveSettings(id: string, settings: WorkspaceSettings): void {
    this.db
      .prepare('UPDATE workspace_settings SET settings_json=?, updated_at=? WHERE workspace_id=?')
      .run(JSON.stringify(settings), Date.now(), id);
  }

  private map(row: WorkspaceRow): Workspace {
    let settings = DEFAULT_WORKSPACE_SETTINGS;
    try {
      const parsed = workspaceSettingsSchema.safeParse(JSON.parse(row.settings_json));
      if (parsed.success) settings = parsed.data;
    } catch {
      // Corrupt non-sensitive settings recover to documented defaults.
      this.onRecovery('workspace.settings');
    }
    return {
      id: row.id,
      name: row.name,
      rootPath: row.canonical_path,
      environment: settings.environment,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      lastOpenedAt: row.last_opened_at ? iso(row.last_opened_at) : null,
    };
  }
}

export class JsonSettingsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly onRecovery: (area: string) => void = () => undefined,
  ) {}
  get<T>(key: string): T | null {
    const row = this.db
      .prepare('SELECT value_json FROM application_settings WHERE key=?')
      .get(key) as { value_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      this.onRecovery('application.settings');
      return null;
    }
  }
  set<T>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO application_settings(key,schema_version,value_json,updated_at) VALUES(?,1,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }
  getLayout(workspaceId: string): WorkspaceLayout | null {
    const row = this.db
      .prepare('SELECT layout_json FROM workspace_layouts WHERE workspace_id=?')
      .get(workspaceId) as { layout_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.layout_json) as WorkspaceLayout;
    } catch {
      this.onRecovery('workspace.layout');
      return null;
    }
  }
  setLayout(workspaceId: string, layout: WorkspaceLayout): void {
    this.db
      .prepare(
        `INSERT INTO workspace_layouts(workspace_id,schema_version,layout_json,updated_at) VALUES(?,1,?,?) ON CONFLICT(workspace_id) DO UPDATE SET layout_json=excluded.layout_json,updated_at=excluded.updated_at`,
      )
      .run(workspaceId, JSON.stringify(layout), Date.now());
  }
}
