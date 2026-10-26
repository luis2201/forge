import type { ApplicationSettings, WorkspaceLayout, WorkspaceSettings } from './contracts.js';

export const DEFAULT_APPLICATION_SETTINGS: ApplicationSettings = {
  theme: 'dark',
  telemetry: false,
  showGitCommands: true,
  gitSensitivePatterns: ['.env', '*.pem', '*.key', 'id_rsa', 'credentials.json'],
};
export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = { environment: 'LOCAL' };
export const DEFAULT_LAYOUT: WorkspaceLayout = {
  sidebarWidth: 280,
  bottomPanelOpen: true,
  bottomPanelHeight: 180,
};
