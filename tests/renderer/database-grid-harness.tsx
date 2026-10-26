import { createRoot } from 'react-dom/client';
import { DatabaseWorkbench } from '../../src/renderer/database/DatabaseWorkbench';

const connection = {
  id: 'connection-1',
  workspaceId: 'workspace-1',
  name: 'MySQL local',
  engine: 'mysql' as const,
  environment: 'LOCAL' as const,
  host: '127.0.0.1',
  port: 3306,
  database: 'forge',
  username: 'forge',
  sslMode: 'disabled' as const,
  sqlitePath: '',
  hasPassword: true,
  connected: true,
  createdAt: '',
  updatedAt: '',
  lastConnectedAt: null,
};

const root = document.getElementById('root');
if (!root) throw new Error('No se encontró el punto de montaje del harness.');

createRoot(root).render(
  <DatabaseWorkbench
    workspaceId="workspace-1"
    selection={{
      connection,
      object: { schema: 'main', name: 'customers', type: 'table' },
    }}
    theme="dark"
    onError={(error) => {
      Object.assign(window, { __rendererError: error });
    }}
    onConfirm={(confirmation) => confirmation.action()}
  />,
);
