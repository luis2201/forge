import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ForgeError,
  GitBranch,
  GitCommit,
  GitDiff,
  GitFileStatus,
  GitHubRemote,
  GitOperationResult,
  GitOverview,
  GitRepository,
  GitStatus,
  Recommendation,
  Result,
} from '../../shared/contracts';

interface GitPanelProps {
  workspaceId: string;
  showGitCommands: boolean;
  onShowDiff: (title: string, diff: GitDiff) => void;
  onResolveConflict: (repositoryPath: string, path: string) => void;
  onResolveSync: (repositoryPath: string) => void;
  onError: (error: ForgeError) => void;
  onConfirm: (request: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    action: () => void;
  }) => void;
}

type GitView = 'changes' | 'history' | 'branches';

const operationLabel: Record<NonNullable<GitStatus['operation']>, string> = {
  merge: 'merge',
  rebase: 'rebase',
  'cherry-pick': 'cherry-pick',
  revert: 'revert',
};

const syncLabels: Record<GitStatus['syncState'], string> = {
  synchronized: 'Local y remoto sincronizados',
  dirty: 'Cambios locales sin confirmar',
  ahead: 'Commits locales pendientes de push',
  behind: 'Commits remotos pendientes de pull',
  diverged: 'Historial local y remoto divergente',
  conflicted: 'Conflictos pendientes',
  'no-upstream': 'Rama local sin upstream',
  'no-remote': 'Repositorio únicamente local',
};

const conflictLabels: Record<NonNullable<GitFileStatus['conflictType']>, string> = {
  'both-modified': 'modificado local y remotamente',
  'both-added': 'añadido local y remotamente',
  'both-deleted': 'eliminado en ambos lados',
  'added-by-us': 'añadido localmente',
  'added-by-them': 'añadido remotamente',
  'deleted-by-us': 'eliminado localmente',
  'deleted-by-them': 'eliminado remotamente',
};

const statusLabel = (file: GitFileStatus): string => {
  if (file.conflicted) return 'C';
  if (file.untracked) return 'U';
  if (file.index === 'A' || file.workingTree === 'A') return 'A';
  if (file.index === 'D' || file.workingTree === 'D') return 'D';
  if (file.index === 'R' || file.workingTree === 'R') return 'R';
  return 'M';
};

export function GitPanel({
  workspaceId,
  showGitCommands,
  onShowDiff,
  onResolveConflict,
  onResolveSync,
  onError,
  onConfirm,
}: GitPanelProps) {
  const [repositories, setRepositories] = useState<GitRepository[]>([]);
  const [repositoryPath, setRepositoryPath] = useState<string | null>(null);
  const [overview, setOverview] = useState<GitOverview | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [history, setHistory] = useState<GitCommit[]>([]);
  const [github, setGithub] = useState<GitHubRemote | null>(null);
  const [view, setView] = useState<GitView>('changes');
  const [commitMessage, setCommitMessage] = useState('');
  const [branchName, setBranchName] = useState('');
  const [initialBranch, setInitialBranch] = useState('main');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [identityName, setIdentityName] = useState('');
  const [identityEmail, setIdentityEmail] = useState('');
  const [identityEditing, setIdentityEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [command, setCommand] = useState('');
  const [remoteUnavailable, setRemoteUnavailable] = useState('');
  const repositoryRef = useRef(repositoryPath);
  const remoteInput = useRef<HTMLInputElement>(null);
  const identityInput = useRef<HTMLInputElement>(null);
  repositoryRef.current = repositoryPath;
  const status = overview?.status ?? null;
  const identity = overview?.identity ?? null;
  const identityAvailable = identity !== null;
  const detectedIdentityName = identity?.name ?? '';
  const detectedIdentityEmail = identity?.email ?? '';
  const detectedIdentityComplete = identity?.complete ?? false;

  const loadRepositories = useCallback(async () => {
    setLoading(true);
    const result = await window.forge.git.repositories(workspaceId);
    setLoading(false);
    if (!result.ok) return onError(result.error);
    setRepositories(result.value);
    setRepositoryPath((current) =>
      current !== null && result.value.some((repository) => repository.path === current)
        ? current
        : (result.value[0]?.path ?? null),
    );
  }, [onError, workspaceId]);

  const refreshDetails = useCallback(
    async (path: string, complete = true) => {
      const [nextOverview, nextBranches, nextHistory] = await Promise.all([
        window.forge.git.overview(workspaceId, path),
        complete ? window.forge.git.branches(workspaceId, path) : null,
        complete ? window.forge.git.history(workspaceId, path, 100) : null,
      ]);
      if (!nextOverview.ok) return onError(nextOverview.error);
      if (repositoryRef.current !== path) return;
      setOverview(nextOverview.value);
      if (nextBranches) {
        if (!nextBranches.ok) return onError(nextBranches.error);
        setBranches(nextBranches.value);
      }
      if (nextHistory) {
        if (!nextHistory.ok) return onError(nextHistory.error);
        setHistory(nextHistory.value);
      }
      setGithub(
        nextOverview.value.status.remotes
          .map((remote) => remote.github)
          .find((remote): remote is GitHubRemote => remote !== null) ?? null,
      );
    },
    [onError, workspaceId],
  );

  useEffect(() => {
    void loadRepositories();
  }, [loadRepositories]);

  useEffect(() => {
    if (repositoryPath === null) {
      setOverview(null);
      setBranches([]);
      setHistory([]);
      setGithub(null);
      return;
    }
    void refreshDetails(repositoryPath);
  }, [refreshDetails, repositoryPath]);

  useEffect(() => {
    if (!identityAvailable) return;
    setIdentityName(detectedIdentityName);
    setIdentityEmail(detectedIdentityEmail);
    setIdentityEditing(!detectedIdentityComplete);
  }, [
    detectedIdentityComplete,
    detectedIdentityEmail,
    detectedIdentityName,
    identityAvailable,
    repositoryPath,
  ]);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (complete: boolean) => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        const path = repositoryRef.current;
        if (path === null) void loadRepositories();
        else void refreshDetails(path, complete);
      }, 220);
    };
    const changed = window.forge.events.subscribe('git.changed', (event) => {
      if (event.workspaceId !== workspaceId) return;
      if (repositoryRef.current === null) void loadRepositories();
      else if (event.repositoryPath === repositoryRef.current) schedule(true);
    });
    const files = window.forge.events.subscribe('file.changed', (event) => {
      if (event.workspaceId !== workspaceId) return;
      const gitMetadata = event.path === '.git' || event.path.includes('/.git/');
      schedule(gitMetadata);
    });
    return () => {
      changed();
      files();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [loadRepositories, refreshDetails, workspaceId]);

  const mutate = useCallback(
    async (
      request: () => Promise<Result<GitOperationResult>>,
      success: string,
      options?: { remote?: boolean; reloadRepositories?: boolean },
    ) => {
      setBusy(true);
      setNotice('');
      setCommand('');
      if (options?.remote) setRemoteUnavailable('');
      const result = await request();
      setBusy(false);
      if (!result.ok) {
        if (options?.remote) setRemoteUnavailable(result.error.message);
        onError(result.error);
        return false;
      }
      setNotice(success);
      if (showGitCommands) setCommand(result.value.command);
      if (options?.reloadRepositories) await loadRepositories();
      else if (repositoryRef.current !== null) await refreshDetails(repositoryRef.current, true);
      return true;
    },
    [loadRepositories, onError, refreshDetails, showGitCommands],
  );

  const showDiff = async (file: GitFileStatus, staged: boolean) => {
    if (repositoryPath === null) return;
    if (file.conflicted) return onResolveConflict(repositoryPath, file.path);
    const result = await window.forge.git.diff(workspaceId, repositoryPath, file.path, staged);
    if (!result.ok) return onError(result.error);
    onShowDiff(`${file.path}${staged ? ' (preparado)' : ''}`, result.value);
  };

  const showCommit = async (commit: GitCommit) => {
    if (repositoryPath === null) return;
    const result = await window.forge.git.show(workspaceId, repositoryPath, commit.hash);
    if (!result.ok) return onError(result.error);
    onShowDiff(`${commit.shortHash} · ${commit.subject}`, result.value);
  };

  const runRecommendation = (recommendation: Recommendation, commandName?: string) => {
    if (repositoryPath === null) return;
    if (commandName === 'git.fetch') {
      void mutate(
        () => window.forge.git.fetch(workspaceId, repositoryPath),
        'Referencias remotas actualizadas.',
        { remote: true },
      );
    } else if (commandName === 'git.push') {
      void mutate(() => window.forge.git.push(workspaceId, repositoryPath), 'Rama publicada.', {
        remote: true,
      });
    } else if (commandName === 'git.configureRemote') {
      remoteInput.current?.focus();
    } else if (commandName === 'git.configureIdentity') {
      setIdentityEditing(true);
      requestAnimationFrame(() => identityInput.current?.focus());
    } else if (commandName === 'git.compareSync' || commandName === 'git.resolveSync') {
      onResolveSync(repositoryPath);
    } else if (commandName === 'git.reviewConflicts') {
      const conflict = status?.files.find((file) => file.conflicted);
      if (conflict) onResolveConflict(repositoryPath, conflict.path);
    } else if (commandName === 'git.reviewSensitiveFiles') {
      setView('changes');
      setNotice(recommendation.details.join(' '));
    }
  };

  const staged = useMemo(
    () => status?.files.filter((file) => file.staged && !file.conflicted) ?? [],
    [status],
  );
  const unstaged = useMemo(() => status?.files.filter((file) => file.unstaged) ?? [], [status]);
  const stagedSensitive = useMemo(
    () => overview?.sensitiveFiles.filter((file) => file.staged) ?? [],
    [overview],
  );

  const commit = (confirmSensitive: boolean) => {
    if (repositoryPath === null) return;
    const message = commitMessage.trim();
    void mutate(
      () => window.forge.git.commit(workspaceId, repositoryPath, message, confirmSensitive),
      'Commit creado.',
    ).then((succeeded) => succeeded && setCommitMessage(''));
  };

  const requestCommit = () => {
    if (stagedSensitive.length === 0) return commit(false);
    onConfirm({
      title: 'Confirmar archivos potencialmente sensibles',
      message: `Repositorio: ${repositoryPath || '.'}\nRama: ${status?.branch ?? 'sin rama'}\n\n${stagedSensitive
        .map((file) => `• ${file.path} coincide con ${file.pattern}`)
        .join('\n')}\n\nForge solo evalúa nombres; revisa el contenido antes de continuar.`,
      confirmLabel: 'Crear commit de todos modos',
      danger: true,
      action: () => commit(true),
    });
  };

  const saveIdentity = () => {
    if (repositoryPath === null) return;
    void mutate(
      () =>
        window.forge.git.configureIdentity(
          workspaceId,
          repositoryPath,
          identityName.trim(),
          identityEmail.trim(),
        ),
      'Identidad Git configurada para este repositorio.',
    );
  };

  const fileRow = (file: GitFileStatus, prepared: boolean) => (
    <div
      className={`git-file-row ${file.conflicted ? 'conflicted' : ''}`}
      key={`${prepared ? 's' : 'u'}-${file.path}`}
    >
      <button
        className="git-file-name"
        title={file.conflicted ? `Resolver ${file.path}` : `Ver diff de ${file.path}`}
        onClick={() => void showDiff(file, prepared)}
      >
        <span>{file.path}</span>
        {file.conflicted ? (
          <small>{conflictLabels[file.conflictType ?? 'both-modified']}</small>
        ) : (
          file.originalPath && <small>desde {file.originalPath}</small>
        )}
      </button>
      <span className={`git-status-code status-${statusLabel(file).toLowerCase()}`}>
        {statusLabel(file)}
      </span>
      {file.conflicted ? (
        <button
          className="git-resolve-action"
          onClick={() => repositoryPath !== null && onResolveConflict(repositoryPath, file.path)}
        >
          Resolver
        </button>
      ) : prepared ? (
        <button
          className="git-row-action"
          title={`Quitar ${file.path} del área de preparación`}
          aria-label={`Quitar ${file.path} del área de preparación`}
          disabled={busy || repositoryPath === null}
          onClick={() =>
            repositoryPath !== null &&
            void mutate(
              () => window.forge.git.unstage(workspaceId, repositoryPath, [file.path]),
              'Cambio retirado del área de preparación.',
            )
          }
        >
          −
        </button>
      ) : (
        <>
          <button
            className="git-row-action"
            title={`Preparar ${file.path}`}
            aria-label={`Preparar ${file.path}`}
            disabled={busy || repositoryPath === null}
            onClick={() =>
              repositoryPath !== null &&
              void mutate(
                () => window.forge.git.stage(workspaceId, repositoryPath, [file.path]),
                'Cambio preparado.',
              )
            }
          >
            ＋
          </button>
          <button
            className="git-row-action danger-text"
            title={`Descartar ${file.path}`}
            aria-label={`Descartar ${file.path}`}
            disabled={busy || repositoryPath === null}
            onClick={() =>
              onConfirm({
                title: 'Descartar cambio',
                message: `Repositorio: ${repositoryPath || '.'}\nRama: ${status?.branch ?? 'sin rama'}\nComando equivalente: ${file.untracked ? 'Mover a la Papelera de Windows' : `git restore --worktree -- ${file.path}`}\n\n${file.untracked ? `“${file.path}” se moverá a la Papelera.` : `Los cambios sin preparar de “${file.path}” se perderán.`}`,
                confirmLabel: file.untracked ? 'Mover a la Papelera' : 'Descartar cambio',
                danger: true,
                action: () => {
                  if (repositoryPath !== null)
                    void mutate(
                      () =>
                        window.forge.git.discard(workspaceId, repositoryPath, [file.path], true),
                      'Cambio descartado.',
                    );
                },
              })
            }
          >
            ×
          </button>
        </>
      )}
    </div>
  );

  const currentRepository = repositories.find((item) => item.path === repositoryPath) ?? null;
  const currentGithub = github ?? currentRepository?.github ?? null;

  return (
    <section className="git-panel">
      <div className="sidebar-heading-row">
        <span>CONTROL DE CÓDIGO FUENTE</span>
        <button
          className="git-refresh"
          title="Actualizar Git"
          onClick={() => {
            if (repositoryRef.current === null) void loadRepositories();
            else void refreshDetails(repositoryRef.current, true);
          }}
        >
          ↻
        </button>
      </div>
      {loading && repositories.length === 0 ? (
        <div className="git-empty">Buscando repositorios Git…</div>
      ) : repositories.length === 0 ? (
        <div className="git-empty git-init-card">
          <strong>No hay un repositorio Git</strong>
          <span>Inicializa el workspace sin salir de Forge.</span>
          <label>
            Rama inicial
            <input
              value={initialBranch}
              onChange={(event) => setInitialBranch(event.target.value)}
              aria-label="Rama inicial"
            />
          </label>
          <button
            className="primary"
            disabled={busy || initialBranch.trim().length === 0}
            onClick={() =>
              void mutate(
                () => window.forge.git.init(workspaceId, '', initialBranch.trim()),
                'Repositorio Git inicializado.',
                { reloadRepositories: true },
              )
            }
          >
            Inicializar repositorio
          </button>
          {showGitCommands && <code>git init -b {initialBranch || 'main'}</code>}
        </div>
      ) : (
        <>
          {repositories.length > 1 && (
            <select
              className="git-repository-select"
              value={repositoryPath ?? ''}
              onChange={(event) => setRepositoryPath(event.target.value)}
              aria-label="Repositorio Git"
            >
              {repositories.map((repository) => (
                <option value={repository.path} key={repository.path}>
                  {repository.name} {repository.path ? `· ${repository.path}` : ''}
                </option>
              ))}
            </select>
          )}
          <div className="git-summary">
            <div>
              <strong>
                {status?.branch ??
                  currentRepository?.currentBranch ??
                  (status?.detached || currentRepository?.detached
                    ? 'HEAD separado'
                    : 'Sin commits')}
              </strong>
              <span>LOCAL · {status?.head?.slice(0, 8) ?? 'sin commit'}</span>
            </div>
            <span>{status ? syncLabels[status.syncState] : 'Leyendo estado…'}</span>
          </div>
          {status && (
            <div className={`git-sync-state sync-${status.syncState}`}>
              <div>
                <span>LOCAL</span>
                <strong>{status.branch ?? 'HEAD separado'}</strong>
                <small>{status.lastCommit?.subject ?? 'Sin commits'}</small>
              </div>
              <b>
                ↑{status.ahead} ↓{status.behind}
              </b>
              <div>
                <span>REMOTO</span>
                <strong>{status.upstream ?? 'Sin upstream'}</strong>
                <small>{status.lastRemoteCommit?.subject ?? 'Sin referencia remota'}</small>
              </div>
            </div>
          )}
          {identity && (
            <section className={`git-identity-card ${identity.complete ? '' : 'missing'}`}>
              <header>
                <div>
                  <strong>{identity.complete ? 'Identidad Git' : 'Falta la identidad Git'}</strong>
                  <span>
                    {identity.complete
                      ? `${identity.name} <${identity.email}>`
                      : 'Git necesita nombre y correo para crear commits.'}
                  </span>
                </div>
                {identity.complete && !identityEditing && (
                  <button onClick={() => setIdentityEditing(true)}>Editar</button>
                )}
              </header>
              {identityEditing && (
                <div className="git-identity-form">
                  <label>
                    Nombre del autor
                    <input
                      ref={identityInput}
                      value={identityName}
                      onChange={(event) => setIdentityName(event.target.value)}
                      maxLength={200}
                      aria-label="Nombre del autor Git"
                      placeholder="Tu nombre"
                    />
                  </label>
                  <label>
                    Correo del autor
                    <input
                      type="email"
                      value={identityEmail}
                      onChange={(event) => setIdentityEmail(event.target.value)}
                      maxLength={320}
                      aria-label="Correo del autor Git"
                      placeholder="tu@correo.com"
                    />
                  </label>
                  <div>
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        identityName.trim().length === 0 ||
                        !/^[^\s@]+@[^\s@]+$/.test(identityEmail.trim())
                      }
                      onClick={saveIdentity}
                    >
                      Guardar identidad
                    </button>
                    {identity.complete && (
                      <button onClick={() => setIdentityEditing(false)}>Cancelar</button>
                    )}
                  </div>
                  <small>
                    Se guardará solo en este repositorio. No es la contraseña ni el token de GitHub.
                  </small>
                </div>
              )}
            </section>
          )}
          <div className="git-sync-actions">
            <button
              title="Fetch actualiza referencias remotas sin modificar tus archivos."
              disabled={busy || status?.remotes.length === 0}
              onClick={() =>
                repositoryPath !== null &&
                void mutate(
                  () => window.forge.git.fetch(workspaceId, repositoryPath),
                  'Referencias remotas actualizadas.',
                  { remote: true },
                )
              }
            >
              Fetch
            </button>
            {status?.syncState === 'diverged' ? (
              <button
                className="resolve-sync-action"
                title="Compara ambas historias y permite elegir Merge o Rebase."
                disabled={busy || repositoryPath === null}
                onClick={() => repositoryPath !== null && onResolveSync(repositoryPath)}
              >
                Resolver sincronización
              </button>
            ) : (
              <button
                title="Pull integra por avance rápido los commits remotos en tu rama local."
                disabled={busy || !status?.upstream || status?.dirty}
                onClick={() =>
                  repositoryPath !== null &&
                  void mutate(
                    () => window.forge.git.pull(workspaceId, repositoryPath),
                    'Cambios remotos integrados.',
                    { remote: true },
                  )
                }
              >
                Pull
              </button>
            )}
            <button
              title={
                status?.head
                  ? 'Push publica tus commits locales. El primer push configura upstream.'
                  : 'Crea el commit inicial antes de publicar la rama.'
              }
              disabled={
                busy ||
                status?.remotes.length === 0 ||
                status?.branch === null ||
                !status?.head ||
                status.behind > 0
              }
              onClick={() =>
                repositoryPath !== null &&
                void mutate(
                  () => window.forge.git.push(workspaceId, repositoryPath),
                  'Rama publicada.',
                  { remote: true },
                )
              }
            >
              Push
            </button>
          </div>
          {remoteUnavailable && (
            <div className="git-remote-error">REMOTO NO DISPONIBLE · {remoteUnavailable}</div>
          )}
          <div className="git-remote-card">
            <strong>Remotos Git</strong>
            {status?.remotes.map((remote) => (
              <span key={remote.name} title={remote.fetchUrl}>
                {remote.name} · {remote.fetchUrl}
              </span>
            ))}
            <div>
              <input
                ref={remoteInput}
                value={remoteUrl}
                onChange={(event) => setRemoteUrl(event.target.value)}
                placeholder="https://github.com/organización/repositorio.git"
                aria-label="URL del remoto origin"
              />
              <button
                disabled={busy || remoteUrl.trim().length === 0}
                onClick={() =>
                  repositoryPath !== null &&
                  void mutate(
                    () =>
                      window.forge.git.setRemote(
                        workspaceId,
                        repositoryPath,
                        'origin',
                        remoteUrl.trim(),
                      ),
                    status?.remotes.some((remote) => remote.name === 'origin')
                      ? 'URL de origin actualizada.'
                      : 'Remoto origin configurado.',
                  ).then((success) => success && setRemoteUrl(''))
                }
              >
                Configurar origin
              </button>
            </div>
            <small>
              Las credenciales se delegan a Git Credential Manager o al sistema; Forge no almacena
              tokens.
            </small>
          </div>
          {currentGithub && (
            <div className="github-card">
              <span>
                GitHub · {currentGithub.owner}/{currentGithub.repository}
              </span>
              <button
                onClick={() =>
                  repositoryPath !== null &&
                  void window.forge.github
                    .openRepository(workspaceId, repositoryPath)
                    .then((result) => !result.ok && onError(result.error))
                }
              >
                Abrir ↗
              </button>
              <small>
                Integración GitHub separada de Git ·{' '}
                {currentGithub.credentialManagerAvailable
                  ? 'Git Credential Manager disponible.'
                  : 'Git Credential Manager no detectado.'}
              </small>
            </div>
          )}
          {overview && overview.recommendations.length > 0 && (
            <div className="git-advisor" aria-label="Recomendaciones Git">
              {overview.recommendations.map((recommendation) => (
                <article
                  className={`recommendation ${recommendation.severity.toLowerCase()}`}
                  key={recommendation.id}
                >
                  <header>
                    <span>{recommendation.severity}</span>
                    <strong>{recommendation.title}</strong>
                  </header>
                  <p>{recommendation.message}</p>
                  {recommendation.details.length > 0 && (
                    <ul>
                      {recommendation.details.map((detail) => (
                        <li key={detail}>{detail}</li>
                      ))}
                    </ul>
                  )}
                  {recommendation.actions.map((action) => (
                    <button
                      key={action.id}
                      onClick={() => runRecommendation(recommendation, action.command)}
                    >
                      {action.label}
                    </button>
                  ))}
                </article>
              ))}
            </div>
          )}
          {status?.operation && (
            <div className="git-operation">
              <span>Operación activa: {operationLabel[status.operation]}</span>
              {(status.operation === 'merge' || status.operation === 'rebase') && (
                <div>
                  {status.conflictCount === 0 && (
                    <button
                      onClick={() =>
                        repositoryPath !== null &&
                        void mutate(
                          () => window.forge.git.continueIntegration(workspaceId, repositoryPath),
                          `${operationLabel[status.operation!]} completado.`,
                        )
                      }
                    >
                      Continuar
                    </button>
                  )}
                  <button
                    onClick={() =>
                      onConfirm({
                        title: `Cancelar ${operationLabel[status.operation!]}`,
                        message: `Repositorio: ${repositoryPath || '.'}\nGit restaurará el estado anterior al inicio de la integración.`,
                        confirmLabel: 'Cancelar integración',
                        danger: true,
                        action: () => {
                          if (repositoryPath !== null)
                            void mutate(
                              () =>
                                window.forge.git.abortIntegration(
                                  workspaceId,
                                  repositoryPath,
                                  true,
                                ),
                              'Integración cancelada.',
                            );
                        },
                      })
                    }
                  >
                    Cancelar
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="git-view-tabs">
            <button
              className={view === 'changes' ? 'active' : ''}
              onClick={() => setView('changes')}
            >
              Cambios {status?.files.length ? `(${status.files.length})` : ''}
            </button>
            <button
              className={view === 'history' ? 'active' : ''}
              onClick={() => setView('history')}
            >
              Historial
            </button>
            <button
              className={view === 'branches' ? 'active' : ''}
              onClick={() => setView('branches')}
            >
              Ramas
            </button>
          </div>
          {(notice || command) && (
            <div className="git-notice">
              {notice && <span>{notice}</span>}
              {command && <code>{command}</code>}
            </div>
          )}
          <div className="git-view-content">
            {view === 'changes' && (
              <>
                <div className="git-commit-box">
                  <textarea
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                    placeholder="Mensaje del commit"
                    maxLength={500}
                    aria-label="Mensaje del commit"
                  />
                  {stagedSensitive.length > 0 && (
                    <div className="sensitive-warning">
                      Revisión sensible: {stagedSensitive.map((file) => file.path).join(', ')}
                    </div>
                  )}
                  <button
                    className="primary compact full"
                    title={
                      identity?.complete ? 'Crear commit' : 'Configura primero la identidad Git'
                    }
                    disabled={
                      busy ||
                      !identity?.complete ||
                      staged.length === 0 ||
                      commitMessage.trim().length === 0
                    }
                    onClick={requestCommit}
                  >
                    {busy ? 'Procesando…' : 'Confirmar cambios'}
                  </button>
                </div>
                <div className="git-group">
                  <header>
                    <strong>PREPARADOS</strong>
                    <span>{staged.length}</span>
                    {staged.length > 0 && (
                      <button
                        title="Quitar todos del área de preparación"
                        onClick={() =>
                          repositoryPath !== null &&
                          void mutate(
                            () =>
                              window.forge.git.unstage(
                                workspaceId,
                                repositoryPath,
                                staged.map((file) => file.path),
                              ),
                            'Cambios retirados del área de preparación.',
                          )
                        }
                      >
                        −
                      </button>
                    )}
                  </header>
                  {staged.map((file) => fileRow(file, true))}
                </div>
                <div className="git-group">
                  <header>
                    <strong>CAMBIOS</strong>
                    <span>{unstaged.length}</span>
                    {unstaged.length > 0 && (
                      <button
                        title="Preparar todos"
                        onClick={() =>
                          repositoryPath !== null &&
                          void mutate(
                            () =>
                              window.forge.git.stage(
                                workspaceId,
                                repositoryPath,
                                unstaged.map((file) => file.path),
                              ),
                            'Cambios preparados.',
                          )
                        }
                      >
                        ＋
                      </button>
                    )}
                  </header>
                  {unstaged.map((file) => fileRow(file, false))}
                </div>
                {status?.files.length === 0 && (
                  <div className="git-empty compact">El árbol de trabajo está limpio.</div>
                )}
              </>
            )}
            {view === 'history' && (
              <div className="git-history">
                {history.map((commit) => (
                  <button key={commit.hash} onClick={() => void showCommit(commit)}>
                    <strong>{commit.subject}</strong>
                    <span>
                      {commit.shortHash} · {commit.author}
                    </span>
                    <time>{new Date(commit.authoredAt).toLocaleString()}</time>
                  </button>
                ))}
                {history.length === 0 && (
                  <div className="git-empty compact">Aún no hay commits.</div>
                )}
              </div>
            )}
            {view === 'branches' && (
              <>
                <div className="git-create-branch">
                  <input
                    value={branchName}
                    onChange={(event) => setBranchName(event.target.value)}
                    placeholder="nueva-rama"
                    aria-label="Nombre de nueva rama"
                  />
                  <button
                    disabled={busy || branchName.trim().length === 0}
                    onClick={() => {
                      if (repositoryPath === null) return;
                      const name = branchName.trim();
                      void mutate(
                        () => window.forge.git.createBranch(workspaceId, repositoryPath, name),
                        `Rama ${name} creada.`,
                      ).then((succeeded) => succeeded && setBranchName(''));
                    }}
                  >
                    Crear y cambiar
                  </button>
                </div>
                <div className="git-branches">
                  {branches.map((branch) => (
                    <div key={`${branch.remote}-${branch.name}`}>
                      <span>
                        {branch.current ? '● ' : ''}
                        {branch.name}
                      </span>
                      {!branch.current && (
                        <>
                          <button
                            disabled={busy}
                            title="Checkout cambia la rama local activa."
                            onClick={() => {
                              if (repositoryPath === null) return;
                              const change = () =>
                                void mutate(
                                  () =>
                                    window.forge.git.checkout(
                                      workspaceId,
                                      repositoryPath,
                                      branch.name,
                                      status?.dirty ?? false,
                                    ),
                                  `Ahora estás en ${branch.name}.`,
                                );
                              if (status?.dirty)
                                onConfirm({
                                  title: 'Cambiar de rama con cambios locales',
                                  message: `Repositorio: ${repositoryPath || '.'}\nRama actual: ${status.branch ?? 'HEAD separado'}\nDestino: ${branch.name}\nComando equivalente: git switch ${branch.name}\n\nLos cambios locales pueden impedir la operación o requerir resolución.`,
                                  confirmLabel: 'Cambiar de rama',
                                  action: change,
                                });
                              else change();
                            }}
                          >
                            Cambiar
                          </button>
                          {!branch.remote && (
                            <button
                              disabled={busy}
                              title="Merge incorpora los commits de otra rama y puede producir conflictos."
                              onClick={() =>
                                onConfirm({
                                  title: 'Fusionar rama',
                                  message: `Repositorio: ${repositoryPath || '.'}\nRama actual: ${status?.branch ?? 'HEAD separado'}\nOrigen: ${branch.name}\nComando equivalente: git merge --no-edit -- ${branch.name}\n\nLa fusión puede producir conflictos que deberán resolverse explícitamente.`,
                                  confirmLabel: 'Fusionar',
                                  action: () => {
                                    if (repositoryPath !== null)
                                      void mutate(
                                        () =>
                                          window.forge.git.merge(
                                            workspaceId,
                                            repositoryPath,
                                            branch.name,
                                            true,
                                          ),
                                        `Rama ${branch.name} fusionada.`,
                                      );
                                  },
                                })
                              }
                            >
                              Merge
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
