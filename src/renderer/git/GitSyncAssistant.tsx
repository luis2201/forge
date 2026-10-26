import { useCallback, useEffect, useState } from 'react';
import type {
  ForgeError,
  GitDiff,
  GitIntegrationStrategy,
  GitOperationResult,
  GitSyncAnalysis,
  GitSyncCommit,
  Result,
} from '../../shared/contracts';
import { GitDiffView } from './GitDiffView';

interface GitSyncAssistantProps {
  workspaceId: string;
  repositoryPath: string;
  showGitCommands: boolean;
  onError: (error: ForgeError) => void;
  onResolveConflict: (repositoryPath: string, path: string) => void;
  onConfirm: (request: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    action: () => void;
  }) => void;
  onClose: () => void;
}

export function GitSyncAssistant({
  workspaceId,
  repositoryPath,
  showGitCommands,
  onError,
  onResolveConflict,
  onConfirm,
  onClose,
}: GitSyncAssistantProps) {
  const [analysis, setAnalysis] = useState<GitSyncAnalysis | null>(null);
  const [strategy, setStrategy] = useState<GitIntegrationStrategy>('merge');
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState('');
  const [command, setCommand] = useState('');
  const [comparisonVisible, setComparisonVisible] = useState(false);
  const [selectedDiff, setSelectedDiff] = useState<{ title: string; diff: GitDiff } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    const response = await window.forge.git.analyzeSync(workspaceId, repositoryPath);
    setBusy(false);
    if (!response.ok) return onError(response.error);
    setAnalysis(response.value);
    setStrategy(response.value.recommendedStrategy);
  }, [onError, repositoryPath, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (
    request: () => Promise<Result<GitOperationResult>>,
    success: string,
  ): Promise<boolean> => {
    setBusy(true);
    setNotice('');
    setCommand('');
    const response = await request();
    setBusy(false);
    if (!response.ok) {
      const state = await window.forge.git.status(workspaceId, repositoryPath);
      const conflict = state.ok ? state.value.files.find((file) => file.conflicted) : null;
      if (conflict) {
        setNotice('Integración pausada: existe un conflicto real que requiere intervención.');
        onResolveConflict(repositoryPath, conflict.path);
        return false;
      }
      onError(response.error);
      return false;
    }
    setNotice(success);
    if (showGitCommands) setCommand(response.value.command);
    await load();
    return true;
  };

  const inspectCommit = async (commit: GitSyncCommit, side: 'LOCAL' | 'REMOTO') => {
    const response = await window.forge.git.show(workspaceId, repositoryPath, commit.hash);
    if (!response.ok) return onError(response.error);
    setSelectedDiff({
      title: `${side} · ${commit.shortHash} · ${commit.subject}`,
      diff: response.value,
    });
  };

  const requestIntegration = () => {
    if (!analysis || analysis.workingTreeDirty) return;
    const isRebase = strategy === 'rebase';
    onConfirm({
      title: `Integrar mediante ${isRebase ? 'Rebase' : 'Merge'}`,
      message: `Repositorio: ${repositoryPath || '.'}\nRama local: ${analysis.localBranch}\nRama remota: ${analysis.remoteBranch}\n\n${
        isRebase
          ? 'Rebase reaplicará los commits locales sobre la referencia remota y reescribirá sus identificadores.'
          : 'Merge conservará ambas líneas de desarrollo y creará un commit de integración cuando sea necesario.'
      }\n\nLos conflictos, si aparecen, requerirán resolución visual explícita.`,
      confirmLabel: `Ejecutar ${isRebase ? 'Rebase' : 'Merge'}`,
      danger: isRebase,
      action: () => {
        void mutate(
          () => window.forge.git.integrateSync(workspaceId, repositoryPath, strategy, true),
          `Integración mediante ${isRebase ? 'Rebase' : 'Merge'} completada.`,
        );
      },
    });
  };

  const requestStash = () =>
    onConfirm({
      title: 'Guardar cambios temporalmente',
      message:
        'Forge ejecutará stash con los cambios rastreados y archivos nuevos. No se realizará automáticamente ni se publicará nada.',
      confirmLabel: 'Crear stash',
      action: () => {
        void mutate(
          () => window.forge.git.stash(workspaceId, repositoryPath, true),
          'Cambios guardados temporalmente. Ya puede resolver la sincronización.',
        );
      },
    });

  const continueIntegration = () => {
    void mutate(
      () => window.forge.git.continueIntegration(workspaceId, repositoryPath),
      'Integración completada y estado Git verificado.',
    );
  };

  const requestAbort = () => {
    if (!analysis?.operation) return;
    onConfirm({
      title: `Cancelar ${analysis.operation}`,
      message:
        'Git restaurará el estado anterior al inicio de la integración. Los cambios previos del usuario se conservarán.',
      confirmLabel: 'Cancelar integración',
      danger: true,
      action: () => {
        void mutate(
          () => window.forge.git.abortIntegration(workspaceId, repositoryPath, true),
          'Integración cancelada.',
        );
      },
    });
  };

  const commitList = (title: 'LOCAL' | 'REMOTO', commits: GitSyncCommit[]) => (
    <section className={`sync-side sync-side-${title.toLowerCase()}`}>
      <header>
        <strong>{title}</strong>
        <span>{commits.length} exclusivos</span>
      </header>
      {commits.map((commit) => (
        <article key={commit.hash}>
          <div>
            <code>{commit.shortHash}</code>
            <strong>{commit.subject}</strong>
            <small>{commit.author}</small>
          </div>
          <ul>
            {commit.files.map((file) => (
              <li key={`${file.status}-${file.path}`}>
                <b>{file.status}</b> {file.path}
              </li>
            ))}
          </ul>
          <button onClick={() => void inspectCommit(commit, title)}>Inspeccionar diff</button>
        </article>
      ))}
      {commits.length === 0 && <p>No hay commits exclusivos en este lado.</p>}
    </section>
  );

  return (
    <section className="sync-assistant" aria-label="Resolver sincronización Git">
      <header className="sync-assistant-header">
        <div>
          <strong>Resolver sincronización Git</strong>
          <span>Comparación e integración explícita, sin pull automático.</span>
        </div>
        <button onClick={onClose} aria-label="Cerrar asistente de sincronización">
          ×
        </button>
      </header>
      {busy && !analysis ? (
        <div className="editor-loading">Analizando las referencias Git…</div>
      ) : analysis ? (
        <div className="sync-assistant-content">
          <section className="sync-summary">
            <div>
              <span>LOCAL</span>
              <strong>{analysis.localBranch}</strong>
              <b>↑{analysis.ahead}</b>
            </div>
            <div className="sync-diverged-mark">DIVERGENTE</div>
            <div>
              <span>REMOTO</span>
              <strong>{analysis.remoteBranch}</strong>
              <b>↓{analysis.behind}</b>
            </div>
          </section>

          {analysis.workingTreeDirty && (
            <section className="sync-dirty-warning" role="alert">
              <strong>Tienes cambios locales sin confirmar.</strong>
              <p>Forge no iniciará Merge ni Rebase hasta que decidas qué hacer con ellos.</p>
              <div>
                <button onClick={onClose}>Revisar cambios</button>
                <button onClick={onClose}>Crear commit</button>
                <button disabled={busy} onClick={requestStash}>
                  Guardar temporalmente (stash)
                </button>
                <button onClick={onClose}>Cancelar</button>
              </div>
            </section>
          )}

          <div className="sync-toolbar">
            <button
              disabled={busy}
              onClick={() =>
                void mutate(
                  () => window.forge.git.fetch(workspaceId, repositoryPath),
                  'Referencias remotas actualizadas sin integrar cambios.',
                )
              }
            >
              Actualizar con Fetch
            </button>
            <button
              className={comparisonVisible ? 'active' : ''}
              onClick={() => setComparisonVisible((visible) => !visible)}
            >
              {comparisonVisible ? 'Ocultar comparación' : 'Comparar cambios'}
            </button>
            <span>
              {analysis.sharedFiles.length === 0
                ? 'Las ramas modifican archivos diferentes.'
                : `${analysis.sharedFiles.length} archivo(s) aparecen en ambos lados; esto no implica por sí solo un conflicto.`}
            </span>
          </div>

          {comparisonVisible && (
            <>
              <div className="sync-sides">
                {commitList('LOCAL', analysis.localCommits)}
                {commitList('REMOTO', analysis.remoteCommits)}
              </div>

              {analysis.sharedFiles.length > 0 && (
                <section className="sync-overlap">
                  <strong>Archivos modificados por ambos lados</strong>
                  {analysis.sharedFiles.map((path) => (
                    <code key={path}>{path}</code>
                  ))}
                  <small>
                    Git determinará durante la integración si las zonas son compatibles.
                  </small>
                </section>
              )}
            </>
          )}

          {analysis.operation && (
            <section className="sync-operation" role="status">
              <div>
                <strong>
                  {analysis.conflictCount > 0
                    ? 'Conflicto real detectado'
                    : `${analysis.operation} listo para completarse`}
                </strong>
                <span>
                  {analysis.conflictCount > 0
                    ? `${analysis.conflictCount} archivo(s) requieren intervención explícita.`
                    : 'Todos los conflictos fueron resueltos y preparados.'}
                </span>
                {analysis.conflictedFiles.map((path) => (
                  <code key={path}>{path}</code>
                ))}
              </div>
              <div>
                {analysis.conflictedFiles[0] && (
                  <button
                    onClick={() => onResolveConflict(repositoryPath, analysis.conflictedFiles[0]!)}
                  >
                    Resolver conflicto
                  </button>
                )}
                {analysis.conflictCount === 0 && (
                  <button className="primary" disabled={busy} onClick={continueIntegration}>
                    Completar {analysis.operation}
                  </button>
                )}
                <button disabled={busy} onClick={requestAbort}>
                  Cancelar integración
                </button>
              </div>
            </section>
          )}

          {analysis.ahead > 0 && analysis.behind > 0 && !analysis.operation && (
            <section className="sync-strategies">
              <strong>Elige una estrategia</strong>
              <label className={strategy === 'merge' ? 'selected' : ''}>
                <input
                  type="radio"
                  name="sync-strategy"
                  checked={strategy === 'merge'}
                  onChange={() => setStrategy('merge')}
                />
                <span>
                  <b>Merge · Recomendado</b>
                  Combina las historias conservando explícitamente ambas líneas de desarrollo.
                </span>
              </label>
              <label className={strategy === 'rebase' ? 'selected' : ''}>
                <input
                  type="radio"
                  name="sync-strategy"
                  checked={strategy === 'rebase'}
                  onChange={() => setStrategy('rebase')}
                />
                <span>
                  <b>Rebase</b>
                  Reaplica tus commits locales sobre la versión remota para mantener un historial
                  lineal.
                </span>
              </label>
              <button
                className="primary"
                disabled={busy || analysis.workingTreeDirty}
                onClick={requestIntegration}
              >
                Integrar mediante {strategy === 'merge' ? 'Merge' : 'Rebase'}
              </button>
            </section>
          )}

          {analysis.behind === 0 && !analysis.operation && (
            <section className="sync-result success">
              <strong>✓ Integración verificada</strong>
              <span>Working tree: {analysis.workingTreeDirty ? 'con cambios' : 'limpio'}</span>
              <span>Conflictos: {analysis.conflictCount}</span>
              <span>Local: ↑{analysis.ahead}</span>
              <span>Remoto: ↓{analysis.behind}</span>
              {analysis.ahead > 0 ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      () => window.forge.git.push(workspaceId, repositoryPath),
                      'Push completado y estado remoto verificado.',
                    )
                  }
                >
                  Push final
                </button>
              ) : (
                <b>✓ Sincronizado</b>
              )}
            </section>
          )}

          {(notice || command) && (
            <div className="sync-notice">
              {notice && <span>{notice}</span>}
              {command && <code>{command}</code>}
            </div>
          )}

          {selectedDiff && (
            <section className="sync-diff-preview">
              <header>
                <strong>{selectedDiff.title}</strong>
                <button onClick={() => setSelectedDiff(null)}>Cerrar comparación</button>
              </header>
              <GitDiffView diff={selectedDiff.diff} />
            </section>
          )}
        </div>
      ) : null}
    </section>
  );
}
