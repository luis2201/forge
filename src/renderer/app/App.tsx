import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApplicationSettings,
  ForgeEnvironment,
  ForgeError,
  GitDiff,
  Workspace,
  WorkspaceLayout,
} from '../../shared/contracts';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { NameDialog } from '../components/NameDialog';
import { DatabaseSidebar, type DatabaseSelection } from '../database/DatabaseSidebar';
import { FileTree } from '../explorer/FileTree';
import { GitDiffView } from '../git/GitDiffView';
import { GitPanel } from '../git/GitPanel';
import { SearchPanel } from '../search/SearchPanel';
import { TerminalPane } from '../terminal/TerminalPane';
import type { OpenFile, SelectedEntry } from './types';

const EditorPane = lazy(() =>
  import('../editor/EditorPane').then((module) => ({ default: module.EditorPane })),
);
const GitConflictResolver = lazy(() =>
  import('../git/GitConflictResolver').then((module) => ({
    default: module.GitConflictResolver,
  })),
);
const GitSyncAssistant = lazy(() =>
  import('../git/GitSyncAssistant').then((module) => ({
    default: module.GitSyncAssistant,
  })),
);
const DatabaseWorkbench = lazy(() =>
  import('../database/DatabaseWorkbench').then((module) => ({
    default: module.DatabaseWorkbench,
  })),
);

const environmentLabels: Record<ForgeEnvironment, string> = {
  LOCAL: 'Local',
  DEVELOPMENT: 'Desarrollo',
  TEST: 'Pruebas',
  STAGING: 'Staging',
  PRODUCTION: 'Producción',
};

interface NameDialogState {
  kind: 'file' | 'directory' | 'rename';
  title: string;
  label: string;
  initialValue?: string;
}

interface ConfirmationState {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => void;
}

const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const nameOf = (path: string): string => path.split('/').at(-1) ?? path;
const joinRelative = (parent: string, name: string): string =>
  parent ? `${parent}/${name}` : name;

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [recent, setRecent] = useState<Workspace[]>([]);
  const [settings, setSettings] = useState<ApplicationSettings>({
    theme: 'dark',
    telemetry: false,
    showGitCommands: true,
    gitSensitivePatterns: ['.env', '*.pem', '*.key', 'id_rsa', 'credentials.json'],
  });
  const [layout, setLayout] = useState<WorkspaceLayout>({
    sidebarWidth: 280,
    bottomPanelOpen: true,
    bottomPanelHeight: 220,
  });
  const [error, setError] = useState<ForgeError | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sideView, setSideView] = useState<'explorer' | 'search' | 'git' | 'database'>('explorer');
  const [selected, setSelected] = useState<SelectedEntry>({ path: '', type: 'directory' });
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [tabs, setTabs] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [gitDocument, setGitDocument] = useState<{ title: string; diff: GitDiff } | null>(null);
  const [gitConflict, setGitConflict] = useState<{
    repositoryPath: string;
    path: string;
  } | null>(null);
  const [gitSync, setGitSync] = useState<{ repositoryPath: string } | null>(null);
  const [databaseSelection, setDatabaseSelection] = useState<DatabaseSelection | null>(null);
  const [navigation, setNavigation] = useState({ path: '', line: 0, key: 0 });
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const resolvedTheme: 'dark' | 'light' =
    settings.theme === 'system'
      ? matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : settings.theme;
  const activeFile = tabs.find((tab) => tab.path === activePath) ?? null;
  const isDirty = (file: OpenFile) => file.content !== file.savedContent;
  const dirtyCount = tabs.filter(isDirty).length;
  const reportError = useCallback((forgeError: ForgeError) => setError(forgeError), []);
  const updateCursor = useCallback(
    (line: number, column: number) => setCursor({ line, column }),
    [],
  );

  const refreshRecent = useCallback(async () => {
    const result = await window.forge.workspace.listRecent();
    if (result.ok) setRecent(result.value);
    else setError(result.error);
  }, []);

  useEffect(() => {
    void refreshRecent();
    void window.forge.application.getSettings().then((result) => {
      if (result.ok) setSettings(result.value);
      else setError(result.error);
    });
    return window.forge.events.subscribe('workspace.opened', () => void refreshRecent());
  }, [refreshRecent]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    void window.forge.application.setDirtyState(dirtyCount).then((result) => {
      if (!result.ok) setError(result.error);
    });
  }, [dirtyCount]);

  const loadWorkspaceState = useCallback(async (item: Workspace) => {
    const savedLayout = await window.forge.layout.get(item.id);
    if (savedLayout.ok) setLayout(savedLayout.value);
    else setError(savedLayout.error);
    setWorkspace(item);
    setSelected({ path: '', type: 'directory' });
    setTabs([]);
    setActivePath(null);
    setGitDocument(null);
    setGitConflict(null);
    setGitSync(null);
    setDatabaseSelection(null);
    setTreeRefresh((value) => value + 1);
  }, []);

  const openFolder = async () => {
    setBusy(true);
    setError(null);
    const result = await window.forge.workspace.chooseAndOpen();
    setBusy(false);
    if (!result.ok) return setError(result.error);
    if (result.value) await loadWorkspaceState(result.value);
  };

  const activate = async (item: Workspace) => {
    setBusy(true);
    setError(null);
    const opened = await window.forge.workspace.openRecent(item.id);
    setBusy(false);
    if (!opened.ok) return setError(opened.error);
    await loadWorkspaceState(opened.value);
  };

  const performCloseWorkspace = useCallback(async () => {
    if (!workspace) return;
    const result = await window.forge.workspace.close(workspace.id);
    if (!result.ok) return setError(result.error);
    setWorkspace(null);
    setTabs([]);
    setActivePath(null);
    setGitDocument(null);
    setGitConflict(null);
    setGitSync(null);
    setDatabaseSelection(null);
    setSettingsOpen(false);
    await refreshRecent();
  }, [refreshRecent, workspace]);

  const closeWorkspace = () => {
    const dirtyCount = tabs.filter(isDirty).length;
    if (dirtyCount > 0) {
      setConfirmation({
        title: 'Cerrar workspace',
        message: `Hay ${dirtyCount} archivo${dirtyCount === 1 ? '' : 's'} sin guardar. Los cambios se perderán.`,
        confirmLabel: 'Cerrar sin guardar',
        danger: true,
        action: () => void performCloseWorkspace(),
      });
    } else void performCloseWorkspace();
  };

  const updateEnvironment = async (environment: ForgeEnvironment) => {
    if (!workspace) return;
    const result = await window.forge.workspace.updateSettings(workspace.id, { environment });
    if (!result.ok) return setError(result.error);
    setWorkspace({ ...workspace, environment: result.value.environment });
  };

  const openFile = useCallback(
    async (path: string, line = 0) => {
      if (!workspace) return;
      setGitDocument(null);
      setGitConflict(null);
      setGitSync(null);
      if (tabsRef.current.some((tab) => tab.path === path)) {
        setActivePath(path);
        if (line) setNavigation({ path, line, key: Date.now() });
        return;
      }
      const result = await window.forge.file.read(workspace.id, path);
      if (!result.ok) return setError(result.error);
      const file: OpenFile = {
        path,
        content: result.value.content,
        savedContent: result.value.content,
        version: result.value.version,
        externalChanged: false,
        deleted: false,
      };
      setTabs((current) => [...current, file]);
      setActivePath(path);
      if (line) setNavigation({ path, line, key: Date.now() });
    },
    [workspace],
  );

  const updateFileContent = useCallback((path: string, content: string) => {
    setTabs((current) => current.map((tab) => (tab.path === path ? { ...tab, content } : tab)));
  }, []);

  const saveFile = useCallback(
    async (path: string, currentEditorContent?: string) => {
      if (!workspace) return;
      const file = tabsRef.current.find((tab) => tab.path === path);
      if (!file || file.deleted) return;
      const content = currentEditorContent ?? file.content;
      const result = await window.forge.file.write(workspace.id, path, content, file.version);
      if (!result.ok) {
        if (result.error.code === 'FILE_MODIFIED_EXTERNALLY') {
          setTabs((current) =>
            current.map((tab) => (tab.path === path ? { ...tab, externalChanged: true } : tab)),
          );
        }
        return setError(result.error);
      }
      setTabs((current) =>
        current.map((tab) =>
          tab.path === path
            ? {
                ...tab,
                savedContent: content,
                version: result.value.version,
                externalChanged: false,
              }
            : tab,
        ),
      );
    },
    [workspace],
  );

  const reloadFile = useCallback(
    async (path: string) => {
      if (!workspace) return;
      const result = await window.forge.file.read(workspace.id, path);
      if (!result.ok) return setError(result.error);
      setTabs((current) =>
        current.map((tab) =>
          tab.path === path
            ? {
                ...tab,
                content: result.value.content,
                savedContent: result.value.content,
                version: result.value.version,
                externalChanged: false,
                deleted: false,
              }
            : tab,
        ),
      );
    },
    [workspace],
  );

  const requestReloadFile = (file: OpenFile) => {
    if (isDirty(file)) {
      setConfirmation({
        title: 'Descartar cambios locales',
        message: `“${nameOf(file.path)}” contiene cambios sin guardar. Se reemplazarán por la versión del disco.`,
        confirmLabel: 'Descartar y recargar',
        danger: true,
        action: () => void reloadFile(file.path),
      });
    } else void reloadFile(file.path);
  };

  const overwriteFile = useCallback(
    async (path: string) => {
      if (!workspace) return;
      const local = tabsRef.current.find((tab) => tab.path === path);
      if (!local) return;
      const disk = await window.forge.file.read(workspace.id, path);
      if (!disk.ok) return setError(disk.error);
      const result = await window.forge.file.write(
        workspace.id,
        path,
        local.content,
        disk.value.version,
      );
      if (!result.ok) return setError(result.error);
      setTabs((current) =>
        current.map((tab) =>
          tab.path === path
            ? {
                ...tab,
                savedContent: tab.content,
                version: result.value.version,
                externalChanged: false,
              }
            : tab,
        ),
      );
    },
    [workspace],
  );

  useEffect(() => {
    if (!workspace) return;
    const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
    const unsubscribe = window.forge.events.subscribe('file.changed', (change) => {
      if (change.workspaceId !== workspace.id) return;
      setTreeRefresh((value) => value + 1);
      if (!tabsRef.current.some((tab) => tab.path === change.path)) return;
      const existing = timeouts.get(change.path);
      if (existing) clearTimeout(existing);
      timeouts.set(
        change.path,
        setTimeout(() => {
          timeouts.delete(change.path);
          void window.forge.file.read(workspace.id, change.path).then((result) => {
            if (!result.ok) {
              if (result.error.code === 'FILE_NOT_FOUND') {
                setTabs((current) =>
                  current.map((tab) =>
                    tab.path === change.path
                      ? { ...tab, deleted: true, externalChanged: true }
                      : tab,
                  ),
                );
              }
              return;
            }
            setTabs((current) =>
              current.map((tab) => {
                if (tab.path !== change.path) return tab;
                if (result.value.content === tab.content) {
                  return {
                    ...tab,
                    savedContent: tab.content,
                    version: result.value.version,
                    externalChanged: false,
                  };
                }
                if (result.value.content === tab.savedContent) {
                  return {
                    ...tab,
                    version: result.value.version,
                    externalChanged: false,
                  };
                }
                if (tab.content !== tab.savedContent) return { ...tab, externalChanged: true };
                return {
                  ...tab,
                  content: result.value.content,
                  savedContent: result.value.content,
                  version: result.value.version,
                  externalChanged: false,
                };
              }),
            );
          });
        }, 180),
      );
    });
    return () => {
      unsubscribe();
      for (const timeout of timeouts.values()) clearTimeout(timeout);
    };
  }, [workspace]);

  const closeTabNow = (path: string) => {
    const index = tabs.findIndex((tab) => tab.path === path);
    const next = tabs.filter((tab) => tab.path !== path);
    setTabs(next);
    if (activePath === path) setActivePath(next[Math.max(0, index - 1)]?.path ?? null);
  };

  const closeTab = (path: string) => {
    const file = tabs.find((tab) => tab.path === path);
    if (file && isDirty(file)) {
      setConfirmation({
        title: 'Cerrar archivo',
        message: `${nameOf(path)} tiene cambios sin guardar.`,
        confirmLabel: 'Descartar cambios',
        danger: true,
        action: () => closeTabNow(path),
      });
    } else closeTabNow(path);
  };

  const selectedParent = useMemo(
    () => (selected.type === 'directory' ? selected.path : parentOf(selected.path)),
    [selected],
  );

  const submitNameDialog = async (value: string) => {
    if (!workspace || !nameDialog) return;
    const dialog = nameDialog;
    setNameDialog(null);
    if (dialog.kind === 'file') {
      const path = joinRelative(selectedParent, value);
      const result = await window.forge.file.createFile(workspace.id, path);
      if (!result.ok) return setError(result.error);
      setTreeRefresh((current) => current + 1);
      await openFile(path);
    } else if (dialog.kind === 'directory') {
      const path = joinRelative(selectedParent, value);
      const result = await window.forge.file.createDirectory(workspace.id, path);
      if (!result.ok) return setError(result.error);
      setTreeRefresh((current) => current + 1);
    } else if (selected.path) {
      const oldPath = selected.path;
      const result = await window.forge.file.rename(workspace.id, oldPath, value);
      if (!result.ok) return setError(result.error);
      const newPath = result.value;
      setTabs((current) =>
        current.map((tab) =>
          tab.path === oldPath || tab.path.startsWith(`${oldPath}/`)
            ? { ...tab, path: `${newPath}${tab.path.slice(oldPath.length)}` }
            : tab,
        ),
      );
      if (activePath === oldPath || activePath?.startsWith(`${oldPath}/`))
        setActivePath(`${newPath}${activePath.slice(oldPath.length)}`);
      setSelected({ path: newPath, type: selected.type });
      setTreeRefresh((current) => current + 1);
    }
  };

  const requestDelete = () => {
    if (!workspace || !selected.path) return;
    const target = selected.path;
    const affectedDirty = tabs.filter(
      (tab) => isDirty(tab) && (tab.path === target || tab.path.startsWith(`${target}/`)),
    ).length;
    setConfirmation({
      title: 'Mover a la Papelera',
      message: `“${nameOf(target)}” se moverá a la Papelera de Windows.${
        affectedDirty > 0
          ? ` También se descartarán cambios sin guardar en ${affectedDirty} archivo${affectedDirty === 1 ? '' : 's'}.`
          : ''
      }`,
      confirmLabel: 'Mover a la Papelera',
      danger: true,
      action: () => {
        void window.forge.file.delete(workspace.id, target).then((result) => {
          if (!result.ok) return setError(result.error);
          setTabs((current) =>
            current.filter((tab) => tab.path !== target && !tab.path.startsWith(`${target}/`)),
          );
          if (activePath === target || activePath?.startsWith(`${target}/`)) setActivePath(null);
          setSelected({ path: parentOf(target), type: 'directory' });
          setTreeRefresh((current) => current + 1);
        });
      },
    });
  };

  const saveLayout = (next: WorkspaceLayout) => {
    setLayout(next);
    if (workspace)
      void window.forge.layout.save(workspace.id, next).then((result) => {
        if (!result.ok) setError(result.error);
      });
  };

  const startSidebarResize = (event: React.PointerEvent) => {
    const startX = event.clientX;
    const startWidth = layout.sidebarWidth;
    let width = startWidth;
    const move = (moveEvent: PointerEvent) => {
      width = Math.max(220, Math.min(520, startWidth + moveEvent.clientX - startX));
      setLayout((current) => ({ ...current, sidebarWidth: width }));
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      saveLayout({ ...layout, sidebarWidth: width });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  const startBottomResize = (event: React.PointerEvent) => {
    const startY = event.clientY;
    const startHeight = layout.bottomPanelHeight;
    let height = startHeight;
    const move = (moveEvent: PointerEvent) => {
      height = Math.max(120, Math.min(500, startHeight + startY - moveEvent.clientY));
      setLayout((current) => ({ ...current, bottomPanelHeight: height }));
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      saveLayout({ ...layout, bottomPanelHeight: height });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  const updateTheme = async (theme: ApplicationSettings['theme']) => {
    const result = await window.forge.application.updateSettings({ theme });
    if (result.ok) setSettings(result.value);
    else setError(result.error);
  };

  const updateApplicationSettings = async (patch: Partial<ApplicationSettings>) => {
    const result = await window.forge.application.updateSettings(patch);
    if (result.ok) setSettings(result.value);
    else setError(result.error);
  };

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">F</span>
          <span>FORGE</span>
        </div>
        <div className="workspace-title">{workspace?.name ?? 'Inicio'}</div>
        <div className="title-actions">
          {workspace && (
            <span className={`environment environment-${workspace.environment.toLowerCase()}`}>
              {environmentLabels[workspace.environment]}
            </span>
          )}
          <button
            className="icon-button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Configuración"
          >
            ⚙
          </button>
        </div>
      </header>

      {workspace ? (
        <div
          className="workspace-grid"
          style={{ gridTemplateColumns: `56px ${layout.sidebarWidth}px 1fr` }}
        >
          <nav className="activity-bar" aria-label="Navegación">
            <button
              className={`activity ${sideView === 'explorer' ? 'active' : ''}`}
              title="Explorador"
              onClick={() => setSideView('explorer')}
            >
              ▱
            </button>
            <button
              className={`activity ${sideView === 'search' ? 'active' : ''}`}
              title="Buscar"
              onClick={() => setSideView('search')}
            >
              ⌕
            </button>
            <button
              className={`activity ${sideView === 'git' ? 'active' : ''}`}
              title="Control de código fuente"
              aria-label="Control de código fuente"
              onClick={() => setSideView('git')}
            >
              ⑂
            </button>
            <button
              className={`activity ${sideView === 'database' ? 'active' : ''}`}
              title="Bases de datos"
              aria-label="Bases de datos"
              onClick={() => setSideView('database')}
            >
              ◉
            </button>
            <div className="spacer" />
            <button
              className="activity"
              title="Configuración"
              onClick={() => setSettingsOpen(true)}
            >
              ⚙
            </button>
          </nav>
          <aside className="sidebar">
            {sideView === 'explorer' ? (
              <>
                <div className="sidebar-heading-row">
                  <span>EXPLORADOR</span>
                  <div className="explorer-actions">
                    <button
                      title="Nuevo archivo"
                      onClick={() =>
                        setNameDialog({
                          kind: 'file',
                          title: 'Nuevo archivo',
                          label: 'Nombre del archivo',
                        })
                      }
                    >
                      ＋
                    </button>
                    <button
                      title="Nueva carpeta"
                      onClick={() =>
                        setNameDialog({
                          kind: 'directory',
                          title: 'Nueva carpeta',
                          label: 'Nombre de la carpeta',
                        })
                      }
                    >
                      ▣
                    </button>
                    <button title="Actualizar" onClick={() => setTreeRefresh((value) => value + 1)}>
                      ↻
                    </button>
                  </div>
                </div>
                <div className="workspace-root">
                  <strong>{workspace.name}</strong>
                  <span>{workspace.rootPath}</span>
                </div>
                <div className="tree-scroll">
                  <FileTree
                    workspaceId={workspace.id}
                    refreshKey={treeRefresh}
                    selected={selected}
                    onSelect={setSelected}
                    onOpen={(path) => void openFile(path)}
                    onError={reportError}
                  />
                </div>
                <div className="selection-actions">
                  <button
                    disabled={!selected.path}
                    onClick={() =>
                      selected.path &&
                      setNameDialog({
                        kind: 'rename',
                        title: 'Renombrar',
                        label: 'Nuevo nombre',
                        initialValue: nameOf(selected.path),
                      })
                    }
                  >
                    Renombrar
                  </button>
                  <button disabled={!selected.path} className="danger-text" onClick={requestDelete}>
                    Eliminar
                  </button>
                </div>
              </>
            ) : sideView === 'search' ? (
              <>
                <div className="sidebar-heading-row">
                  <span>BUSCAR</span>
                </div>
                <SearchPanel
                  workspaceId={workspace.id}
                  onOpen={(path, line) => void openFile(path, line)}
                  onError={reportError}
                />
              </>
            ) : sideView === 'git' ? (
              <GitPanel
                workspaceId={workspace.id}
                showGitCommands={settings.showGitCommands}
                onShowDiff={(title, diff) => {
                  setGitConflict(null);
                  setGitSync(null);
                  setGitDocument({ title, diff });
                }}
                onResolveConflict={(repositoryPath, path) => {
                  setGitDocument(null);
                  setGitSync(null);
                  setGitConflict({ repositoryPath, path });
                }}
                onResolveSync={(repositoryPath) => {
                  setGitDocument(null);
                  setGitConflict(null);
                  setGitSync({ repositoryPath });
                }}
                onError={reportError}
                onConfirm={setConfirmation}
              />
            ) : (
              <DatabaseSidebar
                workspaceId={workspace.id}
                workspaceEnvironment={workspace.environment}
                selection={databaseSelection}
                onSelect={setDatabaseSelection}
                onError={reportError}
                onConfirm={setConfirmation}
              />
            )}
            <div className="sidebar-resizer" onPointerDown={startSidebarResize} />
          </aside>
          <section className="workbench">
            <div className="tab-strip">
              {sideView === 'database' && (
                <button className="tab active" title="Herramientas de base de datos">
                  <span>
                    Base de datos
                    {databaseSelection ? ` · ${databaseSelection.connection.name}` : ''}
                  </span>
                </button>
              )}
              {sideView !== 'database' && gitConflict && (
                <button className="tab active" title={gitConflict.path}>
                  <span>Conflicto · {nameOf(gitConflict.path)}</span>
                  <span
                    className="tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      setGitConflict(null);
                    }}
                  >
                    ×
                  </span>
                </button>
              )}
              {sideView !== 'database' && gitSync && !gitConflict && (
                <button className="tab active" title="Resolver sincronización Git">
                  <span>Sincronización Git</span>
                  <span
                    className="tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      setGitSync(null);
                    }}
                  >
                    ×
                  </span>
                </button>
              )}
              {sideView !== 'database' && gitDocument && (
                <button className="tab active" title={gitDocument.title}>
                  <span>{gitDocument.title}</span>
                  <span
                    className="tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      setGitDocument(null);
                    }}
                  >
                    ×
                  </span>
                </button>
              )}
              {sideView !== 'database' &&
                tabs.map((tab) => (
                  <button
                    key={tab.path}
                    className={`tab ${!gitDocument && !gitConflict && !gitSync && activePath === tab.path ? 'active' : ''}`}
                    onClick={() => {
                      setGitDocument(null);
                      setGitConflict(null);
                      setGitSync(null);
                      setActivePath(tab.path);
                    }}
                    title={tab.path}
                  >
                    <span>{nameOf(tab.path)}</span>
                    {isDirty(tab) && <i className="dirty-dot" />}
                    <span
                      className="tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab.path);
                      }}
                    >
                      ×
                    </span>
                  </button>
                ))}
            </div>
            <div className="editor-region">
              {sideView === 'database' ? (
                <Suspense fallback={<div className="editor-loading">Cargando bases de datos…</div>}>
                  <DatabaseWorkbench
                    workspaceId={workspace.id}
                    selection={databaseSelection}
                    theme={resolvedTheme}
                    onError={reportError}
                    onConfirm={setConfirmation}
                  />
                </Suspense>
              ) : gitConflict ? (
                <Suspense fallback={<div className="editor-loading">Cargando resolver…</div>}>
                  <GitConflictResolver
                    workspaceId={workspace.id}
                    repositoryPath={gitConflict.repositoryPath}
                    path={gitConflict.path}
                    theme={resolvedTheme}
                    showGitCommands={settings.showGitCommands}
                    onError={reportError}
                    onResolved={() => setGitConflict(null)}
                    onClose={() => setGitConflict(null)}
                  />
                </Suspense>
              ) : gitSync ? (
                <Suspense fallback={<div className="editor-loading">Cargando asistente…</div>}>
                  <GitSyncAssistant
                    workspaceId={workspace.id}
                    repositoryPath={gitSync.repositoryPath}
                    showGitCommands={settings.showGitCommands}
                    onError={reportError}
                    onResolveConflict={(repositoryPath, path) => {
                      setGitConflict({ repositoryPath, path });
                    }}
                    onConfirm={setConfirmation}
                    onClose={() => setGitSync(null)}
                  />
                </Suspense>
              ) : gitDocument ? (
                <GitDiffView diff={gitDocument.diff} />
              ) : activeFile ? (
                <>
                  {activeFile.externalChanged && (
                    <div className="conflict-banner">
                      <span>
                        {activeFile.deleted
                          ? 'El archivo fue eliminado fuera de Forge.'
                          : 'El archivo cambió fuera de Forge.'}
                      </span>
                      <div>
                        {!activeFile.deleted && (
                          <button onClick={() => requestReloadFile(activeFile)}>Recargar</button>
                        )}
                        {!activeFile.deleted && (
                          <button
                            className="warning"
                            onClick={() => void overwriteFile(activeFile.path)}
                          >
                            Sobrescribir
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  <Suspense fallback={<div className="editor-loading">Cargando editor…</div>}>
                    <EditorPane
                      workspaceId={workspace.id}
                      file={activeFile}
                      theme={resolvedTheme}
                      navigationLine={
                        navigation.path === activeFile.path ? navigation.line : undefined
                      }
                      navigationKey={navigation.key}
                      openPaths={tabs.map((tab) => tab.path)}
                      onChange={updateFileContent}
                      onSave={(path, content) => void saveFile(path, content)}
                      onCursorChange={updateCursor}
                    />
                  </Suspense>
                </>
              ) : (
                <div className="canvas">
                  <div className="welcome-compact">
                    <div className="forge-glyph">F</div>
                    <h1>{workspace.name}</h1>
                    <p>Selecciona un archivo para comenzar a editar.</p>
                    <dl>
                      <div>
                        <dt>Raíz autorizada</dt>
                        <dd>{workspace.rootPath}</dd>
                      </div>
                      <div>
                        <dt>Atajos</dt>
                        <dd>Ctrl+S guardar · Ctrl+P próximamente</dd>
                      </div>
                    </dl>
                  </div>
                </div>
              )}
            </div>
            <div
              className="bottom-panel terminal-panel"
              hidden={!layout.bottomPanelOpen}
              style={{ height: layout.bottomPanelHeight }}
            >
              <div className="bottom-resizer" onPointerDown={startBottomResize} />
              <TerminalPane
                workspaceId={workspace.id}
                theme={resolvedTheme}
                onError={reportError}
              />
            </div>
            <button
              className="panel-toggle"
              onClick={() => saveLayout({ ...layout, bottomPanelOpen: !layout.bottomPanelOpen })}
            >
              {layout.bottomPanelOpen ? 'Ocultar panel' : 'Mostrar terminal'}
            </button>
          </section>
        </div>
      ) : (
        <section className="start-page">
          <div className="hero">
            <div className="forge-glyph large">F</div>
            <h1>Forge</h1>
            <p>Tu entorno de desarrollo, en un solo lugar.</p>
            <button className="primary" onClick={() => void openFolder()} disabled={busy}>
              {busy ? 'Abriendo…' : 'Abrir carpeta'}
            </button>
          </div>
          <div className="recent-section">
            <div className="section-title">
              <h2>Recientes</h2>
              <span>{recent.length} workspaces</span>
            </div>
            {recent.length === 0 ? (
              <div className="empty">
                <p>Aún no hay workspaces recientes.</p>
                <span>Abre una carpeta local para comenzar.</span>
              </div>
            ) : (
              <div className="recent-list">
                {recent.map((item) => (
                  <button
                    key={item.id}
                    className="recent-item"
                    onClick={() => void activate(item)}
                    disabled={busy}
                  >
                    <span className="folder-icon">◇</span>
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.rootPath}</small>
                    </span>
                    <time>
                      {item.lastOpenedAt ? new Date(item.lastOpenedAt).toLocaleDateString() : ''}
                    </time>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <footer className="statusbar">
        <span>Forge 0.4.0</span>
        <span>
          {sideView === 'database' && workspace
            ? databaseSelection
              ? `${databaseSelection.connection.name} · ${databaseSelection.connection.environment}`
              : 'Bases de datos · Sin conexión seleccionada'
            : gitConflict
              ? `${gitConflict.path} · Resolver conflicto Git`
              : gitSync
                ? 'Sincronización Git · Asistente de integración'
                : gitDocument
                  ? `${gitDocument.title} · Vista Git de sólo lectura`
                  : activeFile
                    ? `${activeFile.path} · Ln ${cursor.line}, Col ${cursor.column}${isDirty(activeFile) ? ' · Modificado' : ''}`
                    : workspace
                      ? `${environmentLabels[workspace.environment]} · Workspace activo`
                      : 'Listo'}
        </span>
      </footer>
      {error && (
        <div className="error-toast" role="alert">
          <strong>{error.message}</strong>
          {error.remediation?.map((item) => (
            <span key={item}>{item}</span>
          ))}
          {typeof error.details?.technical === 'string' && (
            <details>
              <summary>Ver detalles técnicos</summary>
              <code>{error.details.technical}</code>
            </details>
          )}
          <small>ID: {error.correlationId}</small>
          <button onClick={() => setError(null)}>Cerrar</button>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <h2>Configuración</h2>
              <button className="icon-button" onClick={() => setSettingsOpen(false)}>
                ×
              </button>
            </header>
            <label>
              Tema
              <select
                value={settings.theme}
                onChange={(event) =>
                  void updateTheme(event.target.value as ApplicationSettings['theme'])
                }
              >
                <option value="dark">Oscuro</option>
                <option value="light">Claro</option>
                <option value="system">Sistema</option>
              </select>
            </label>
            {workspace && (
              <label>
                Entorno
                <select
                  value={workspace.environment}
                  onChange={(event) =>
                    void updateEnvironment(event.target.value as ForgeEnvironment)
                  }
                >
                  {Object.entries(environmentLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="setting-row">
              <span>Telemetría</span>
              <strong>Desactivada</strong>
            </div>
            <label className="setting-checkbox">
              <input
                type="checkbox"
                checked={settings.showGitCommands}
                onChange={(event) =>
                  void updateApplicationSettings({ showGitCommands: event.target.checked })
                }
              />
              Mostrar comandos Git equivalentes
            </label>
            <label>
              Patrones de archivos sensibles
              <textarea
                key={settings.gitSensitivePatterns.join('\0')}
                defaultValue={settings.gitSensitivePatterns.join(', ')}
                rows={3}
                onBlur={(event) => {
                  const patterns = event.target.value
                    .split(',')
                    .map((pattern) => pattern.trim())
                    .filter(Boolean);
                  if (patterns.length > 0)
                    void updateApplicationSettings({ gitSensitivePatterns: patterns });
                }}
                aria-label="Patrones de archivos sensibles"
              />
              <small>Separados por coma. Se evalúan antes de cada commit.</small>
            </label>
            {workspace && (
              <button className="secondary full" onClick={closeWorkspace}>
                Cerrar workspace
              </button>
            )}
            <p className="privacy-note">Forge no envía datos de uso.</p>
          </section>
        </div>
      )}
      {nameDialog && (
        <NameDialog
          {...nameDialog}
          confirmLabel={nameDialog.kind === 'rename' ? 'Renombrar' : 'Crear'}
          onConfirm={(value) => void submitNameDialog(value)}
          onCancel={() => setNameDialog(null)}
        />
      )}
      {confirmation && (
        <ConfirmDialog
          {...confirmation}
          onConfirm={() => {
            const action = confirmation.action;
            setConfirmation(null);
            action();
          }}
          onCancel={() => setConfirmation(null)}
        />
      )}
    </main>
  );
}
