import { useEffect, useRef, useState } from 'react';
import type { ForgeError, GitConflictContent, GitOperationResult } from '../../shared/contracts';
import { languageForPath, monaco } from '../editor/monaco';

interface GitConflictResolverProps {
  workspaceId: string;
  repositoryPath: string;
  path: string;
  theme: 'dark' | 'light';
  showGitCommands: boolean;
  onError: (error: ForgeError) => void;
  onResolved: (result: GitOperationResult) => void;
  onClose: () => void;
}

export function GitConflictResolver({
  workspaceId,
  repositoryPath,
  path,
  theme,
  showGitCommands,
  onError,
  onResolved,
  onClose,
}: GitConflictResolverProps) {
  const comparisonHost = useRef<HTMLDivElement>(null);
  const resultHost = useRef<HTMLDivElement>(null);
  const comparison = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const resultEditor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const conflictRef = useRef<GitConflictContent | null>(null);
  const [conflict, setConflict] = useState<GitConflictContent | null>(null);
  const [busy, setBusy] = useState(true);
  const [choice, setChoice] = useState<'local' | 'remote' | 'both' | 'edit'>('edit');
  const [deleteResult, setDeleteResult] = useState(false);
  const [command, setCommand] = useState('');

  useEffect(() => {
    let active = true;
    setBusy(true);
    void window.forge.git.conflict(workspaceId, repositoryPath, path).then((response) => {
      if (!active) return;
      setBusy(false);
      if (!response.ok) return onError(response.error);
      conflictRef.current = response.value;
      setConflict(response.value);
    });
    return () => {
      active = false;
    };
  }, [onError, path, repositoryPath, workspaceId]);

  useEffect(() => {
    if (!conflict || !comparisonHost.current || !resultHost.current) return;
    const language = languageForPath(path);
    const localModel = monaco.editor.createModel(
      conflict.local ?? '',
      language,
      monaco.Uri.parse(`forge-conflict://local/${encodeURIComponent(path)}`),
    );
    const remoteModel = monaco.editor.createModel(
      conflict.remote ?? '',
      language,
      monaco.Uri.parse(`forge-conflict://remote/${encodeURIComponent(path)}`),
    );
    const resultModel = monaco.editor.createModel(
      conflict.result,
      language,
      monaco.Uri.parse(`forge-conflict://result/${encodeURIComponent(path)}`),
    );
    const diff = monaco.editor.createDiffEditor(comparisonHost.current, {
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      originalEditable: false,
      minimap: { enabled: false },
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 12,
      theme: theme === 'dark' ? 'vs-dark' : 'vs',
    });
    diff.setModel({ original: localModel, modified: remoteModel });
    const editor = monaco.editor.create(resultHost.current, {
      automaticLayout: true,
      model: resultModel,
      minimap: { enabled: false },
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 12,
      scrollBeyondLastLine: false,
      theme: theme === 'dark' ? 'vs-dark' : 'vs',
    });
    comparison.current = diff;
    resultEditor.current = editor;
    return () => {
      comparison.current = null;
      resultEditor.current = null;
      diff.dispose();
      editor.dispose();
      localModel.dispose();
      remoteModel.dispose();
      resultModel.dispose();
    };
  }, [conflict, path, theme]);

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
  }, [theme]);

  const choose = (next: 'local' | 'remote' | 'both' | 'edit') => {
    if (!conflict || !resultEditor.current) return;
    setChoice(next);
    if (next === 'edit') {
      setDeleteResult(false);
      resultEditor.current.focus();
      return;
    }
    const selected =
      next === 'local'
        ? conflict.local
        : next === 'remote'
          ? conflict.remote
          : [conflict.local, conflict.remote].filter((value) => value !== null).join('\n');
    setDeleteResult(selected === null);
    resultEditor.current.setValue(selected ?? '');
  };

  const resolve = async () => {
    if (!conflictRef.current || !resultEditor.current) return;
    setBusy(true);
    setCommand('');
    const response = await window.forge.git.resolveConflict(
      workspaceId,
      repositoryPath,
      path,
      deleteResult ? null : resultEditor.current.getValue(),
      conflictRef.current.version,
    );
    setBusy(false);
    if (!response.ok) return onError(response.error);
    if (showGitCommands) setCommand(response.value.command);
    onResolved(response.value);
  };

  return (
    <section className="conflict-resolver" aria-label={`Resolver conflicto ${path}`}>
      <header>
        <div>
          <strong>Resolución visual de conflicto</strong>
          <span>{path}</span>
        </div>
        <button onClick={onClose} aria-label="Cerrar resolver">
          ×
        </button>
      </header>
      {busy && !conflict ? (
        <div className="editor-loading">Cargando versiones del conflicto…</div>
      ) : conflict ? (
        <>
          <div className="conflict-labels">
            <span>LOCAL {conflict.local === null ? '· eliminado' : ''}</span>
            <span>REMOTO {conflict.remote === null ? '· eliminado' : ''}</span>
          </div>
          <div className="conflict-comparison" ref={comparisonHost} />
          <div className="conflict-toolbar">
            <span>RESULTADO</span>
            <button className={choice === 'local' ? 'active' : ''} onClick={() => choose('local')}>
              Aceptar local
            </button>
            <button
              className={choice === 'remote' ? 'active' : ''}
              onClick={() => choose('remote')}
            >
              Aceptar remoto
            </button>
            <button className={choice === 'both' ? 'active' : ''} onClick={() => choose('both')}>
              Aceptar ambos
            </button>
            <button className={choice === 'edit' ? 'active' : ''} onClick={() => choose('edit')}>
              Editar
            </button>
          </div>
          <div className={`conflict-delete-note ${deleteResult ? '' : 'hidden'}`}>
            {deleteResult ? 'El resultado seleccionado elimina el archivo.' : 'Resultado editable.'}
          </div>
          <div className="conflict-result" ref={resultHost} />
          <footer>
            <div>
              <strong>Marcar como resuelto es una acción explícita.</strong>
              <span>
                Forge guardará el resultado y ejecutará git add o git rm sobre este archivo.
              </span>
              {command && <code>{command}</code>}
            </div>
            <button className="primary" disabled={busy} onClick={() => void resolve()}>
              {busy ? 'Resolviendo…' : 'Marcar como resuelto'}
            </button>
          </footer>
        </>
      ) : null}
    </section>
  );
}
