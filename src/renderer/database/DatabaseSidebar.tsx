import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DatabaseCatalog,
  DatabaseConnectionInput,
  DatabaseConnectionProfile,
  DatabaseEngine,
  DatabaseObject,
  ForgeEnvironment,
  ForgeError,
} from '../../shared/contracts';

export interface DatabaseSelection {
  connection: DatabaseConnectionProfile;
  object: DatabaseObject | null;
}

interface Confirmation {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => void;
}

interface Props {
  workspaceId: string;
  workspaceEnvironment: ForgeEnvironment;
  selection: DatabaseSelection | null;
  onSelect: (selection: DatabaseSelection | null) => void;
  onError: (error: ForgeError) => void;
  onConfirm: (confirmation: Confirmation) => void;
}

const engineLabels: Record<DatabaseEngine, string> = {
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
};

const defaults = (
  environment: ForgeEnvironment,
  engine: DatabaseEngine = 'sqlite',
): DatabaseConnectionInput => ({
  name: '',
  engine,
  environment,
  host: engine === 'sqlite' ? '' : 'localhost',
  port: engine === 'mysql' ? 3306 : engine === 'postgresql' ? 5432 : null,
  database: '',
  username: '',
  sslMode: 'disabled',
  sqlitePath: engine === 'sqlite' ? 'database.sqlite' : '',
});

export function DatabaseSidebar({
  workspaceId,
  workspaceEnvironment,
  selection,
  onSelect,
  onError,
  onConfirm,
}: Props) {
  const [connections, setConnections] = useState<DatabaseConnectionProfile[]>([]);
  const [catalog, setCatalog] = useState<DatabaseCatalog | null>(null);
  const [editing, setEditing] = useState<DatabaseConnectionProfile | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await window.forge.database.listConnections(workspaceId);
    if (!response.ok) return onError(response.error);
    setConnections(response.value);
  }, [onError, workspaceId]);

  useEffect(() => {
    void refresh();
    return window.forge.events.subscribe('database.changed', (event) => {
      if (event.workspaceId === workspaceId) void refresh();
    });
  }, [refresh, workspaceId]);

  const loadCatalog = useCallback(
    async (connection: DatabaseConnectionProfile) => {
      setBusy(connection.id);
      let current = connection;
      if (!connection.connected) {
        const connected = await window.forge.database.connect(workspaceId, connection.id);
        if (!connected.ok) {
          setBusy(null);
          return onError(connected.error);
        }
        current = connected.value;
      }
      const response = await window.forge.database.catalog(workspaceId, connection.id);
      setBusy(null);
      if (!response.ok) return onError(response.error);
      setCatalog(response.value);
      onSelect({ connection: current, object: null });
    },
    [onError, onSelect, workspaceId],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, DatabaseObject[]>();
    for (const object of catalog?.objects ?? []) {
      const items = groups.get(object.schema) ?? [];
      items.push(object);
      groups.set(object.schema, items);
    }
    return [...groups.entries()];
  }, [catalog]);

  const disconnect = async (connection: DatabaseConnectionProfile) => {
    const response = await window.forge.database.disconnect(workspaceId, connection.id);
    if (!response.ok) return onError(response.error);
    setCatalog(null);
    if (selection?.connection.id === connection.id) onSelect(null);
  };

  const remove = (connection: DatabaseConnectionProfile) => {
    onConfirm({
      title: 'Eliminar conexión',
      message: `Se eliminará “${connection.name}” y su credencial cifrada. La base de datos no será modificada.`,
      confirmLabel: 'Eliminar conexión',
      danger: true,
      action: () => {
        void window.forge.database
          .deleteConnection(workspaceId, connection.id, true)
          .then((response) => {
            if (!response.ok) onError(response.error);
            else if (selection?.connection.id === connection.id) onSelect(null);
          });
      },
    });
  };

  return (
    <div className="database-sidebar">
      <div className="sidebar-heading-row">
        <span>BASES DE DATOS</span>
        <button title="Nueva conexión" onClick={() => setEditing('new')}>
          ＋
        </button>
      </div>
      <div className="database-connections">
        {connections.length === 0 ? (
          <div className="database-empty">
            <strong>Sin conexiones</strong>
            <span>Agrega MySQL, PostgreSQL o SQLite para este workspace.</span>
            <button onClick={() => setEditing('new')}>Agregar conexión</button>
          </div>
        ) : (
          connections.map((connection) => (
            <div
              className={`database-connection ${selection?.connection.id === connection.id ? 'active' : ''}`}
              key={connection.id}
            >
              <button
                className="database-connection-main"
                disabled={busy === connection.id}
                onClick={() => void loadCatalog(connection)}
              >
                <span className={`database-engine engine-${connection.engine}`}>
                  {connection.engine === 'sqlite' ? 'S' : connection.engine === 'mysql' ? 'M' : 'P'}
                </span>
                <span>
                  <strong>{connection.name}</strong>
                  <small>
                    {engineLabels[connection.engine]} · {connection.environment}
                  </small>
                </span>
                <i
                  className={connection.connected ? 'online' : ''}
                  title={connection.connected ? 'Conectada' : 'Desconectada'}
                />
              </button>
              <div className="database-connection-actions">
                <button title="Editar conexión" onClick={() => setEditing(connection)}>
                  ✎
                </button>
                {connection.connected && (
                  <button title="Desconectar" onClick={() => void disconnect(connection)}>
                    ◌
                  </button>
                )}
                <button title="Eliminar conexión" onClick={() => remove(connection)}>
                  ×
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {selection && catalog && (
        <div className="database-catalog">
          <header>
            <span>ESTRUCTURA</span>
            <button
              title="Actualizar estructura"
              onClick={() => void loadCatalog(selection.connection)}
            >
              ↻
            </button>
          </header>
          {grouped.map(([schema, objects]) => (
            <details open key={schema}>
              <summary>{schema}</summary>
              {objects.map((object) => (
                <button
                  className={
                    selection.object?.schema === object.schema &&
                    selection.object.name === object.name
                      ? 'active'
                      : ''
                  }
                  key={`${object.schema}.${object.name}`}
                  onClick={() => onSelect({ connection: selection.connection, object })}
                >
                  <span>{object.type === 'view' ? '◈' : '▦'}</span>
                  <span>{object.name}</span>
                  <small>{object.type === 'view' ? 'vista' : 'tabla'}</small>
                </button>
              ))}
            </details>
          ))}
          {catalog.objects.length === 0 && <p>No hay tablas ni vistas visibles.</p>}
        </div>
      )}
      {editing && (
        <ConnectionDialog
          workspaceId={workspaceId}
          environment={workspaceEnvironment}
          connection={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(profile) => {
            setEditing(null);
            void refresh();
            void loadCatalog(profile);
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

function ConnectionDialog({
  workspaceId,
  environment,
  connection,
  onClose,
  onSaved,
  onError,
}: {
  workspaceId: string;
  environment: ForgeEnvironment;
  connection: DatabaseConnectionProfile | null;
  onClose: () => void;
  onSaved: (profile: DatabaseConnectionProfile) => void;
  onError: (error: ForgeError) => void;
}) {
  const [profile, setProfile] = useState<DatabaseConnectionInput>(() =>
    connection
      ? {
          name: connection.name,
          engine: connection.engine,
          environment: connection.environment,
          host: connection.host,
          port: connection.port,
          database: connection.database,
          username: connection.username,
          sslMode: connection.sslMode,
          sqlitePath: connection.sqlitePath,
        }
      : defaults(environment),
  );
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [saving, setSaving] = useState(false);

  const patch = <K extends keyof DatabaseConnectionInput>(
    key: K,
    value: DatabaseConnectionInput[K],
  ) => setProfile((current) => ({ ...current, [key]: value }));

  const switchEngine = (engine: DatabaseEngine) => {
    setProfile((current) => ({ ...defaults(current.environment, engine), name: current.name }));
    setTested(false);
  };

  const test = async () => {
    setTesting(true);
    setTested(false);
    const response = await window.forge.database.testConnection(
      workspaceId,
      profile,
      password || undefined,
    );
    setTesting(false);
    if (!response.ok) return onError(response.error);
    setTested(true);
  };

  const save = async () => {
    setSaving(true);
    const passwordValue = clearPassword ? '' : password || undefined;
    const response = await window.forge.database.saveConnection(
      workspaceId,
      connection?.id ?? null,
      profile,
      passwordValue,
    );
    setSaving(false);
    if (!response.ok) return onError(response.error);
    onSaved(response.value);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal database-connection-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>{connection ? 'Editar conexión' : 'Nueva conexión'}</h2>
            <p>La contraseña se cifra con la protección de Windows y nunca vuelve al renderer.</p>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="database-form-grid">
          <label>
            Motor
            <select
              value={profile.engine}
              onChange={(event) => switchEngine(event.target.value as DatabaseEngine)}
            >
              <option value="sqlite">SQLite</option>
              <option value="mysql">MySQL</option>
              <option value="postgresql">PostgreSQL</option>
            </select>
          </label>
          <label>
            Nombre
            <input
              value={profile.name}
              maxLength={120}
              onChange={(event) => patch('name', event.target.value)}
            />
          </label>
          <label>
            Entorno
            <select
              value={profile.environment}
              onChange={(event) => patch('environment', event.target.value as ForgeEnvironment)}
            >
              <option value="LOCAL">Local</option>
              <option value="DEVELOPMENT">Desarrollo</option>
              <option value="TEST">Pruebas</option>
              <option value="STAGING">Staging</option>
              <option value="PRODUCTION">Producción</option>
            </select>
          </label>
          {profile.engine === 'sqlite' ? (
            <label className="wide">
              Ruta SQLite relativa al workspace
              <input
                value={profile.sqlitePath}
                placeholder="data/app.sqlite"
                onChange={(event) => patch('sqlitePath', event.target.value)}
              />
              <small>
                Puede apuntar a un archivo existente o crear uno nuevo dentro del workspace.
              </small>
            </label>
          ) : (
            <>
              <label>
                Host
                <input
                  value={profile.host}
                  onChange={(event) => patch('host', event.target.value)}
                />
              </label>
              <label>
                Puerto
                <input
                  type="number"
                  value={profile.port ?? ''}
                  onChange={(event) =>
                    patch('port', event.target.value ? Number(event.target.value) : null)
                  }
                />
              </label>
              <label>
                Base de datos
                <input
                  value={profile.database}
                  onChange={(event) => patch('database', event.target.value)}
                />
              </label>
              <label>
                Usuario
                <input
                  value={profile.username}
                  onChange={(event) => patch('username', event.target.value)}
                />
              </label>
              <label>
                Contraseña {connection?.hasPassword && <small>guardada</small>}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  disabled={clearPassword}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label>
                TLS
                <select
                  value={profile.sslMode}
                  onChange={(event) =>
                    patch('sslMode', event.target.value as DatabaseConnectionInput['sslMode'])
                  }
                >
                  <option value="disabled">Desactivado</option>
                  <option value="preferred">Cifrado sin validar certificado</option>
                  <option value="required">Cifrado y certificado válido</option>
                </select>
              </label>
              {connection?.hasPassword && (
                <label className="setting-checkbox wide">
                  <input
                    type="checkbox"
                    checked={clearPassword}
                    onChange={(event) => setClearPassword(event.target.checked)}
                  />
                  Eliminar contraseña guardada
                </label>
              )}
            </>
          )}
        </div>
        <footer>
          <span className={tested ? 'database-test-ok' : ''}>
            {tested ? 'Conexión verificada.' : 'Prueba antes de guardar cuando cambies el acceso.'}
          </span>
          <div>
            <button onClick={() => void test()} disabled={testing || !profile.name}>
              {testing ? 'Probando…' : 'Probar'}
            </button>
            <button
              className="primary"
              onClick={() => void save()}
              disabled={saving || !profile.name}
            >
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
