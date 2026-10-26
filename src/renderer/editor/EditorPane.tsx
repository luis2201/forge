import { useEffect, useRef } from 'react';
import type { OpenFile } from '../app/types';
import { languageForPath, monaco } from './monaco';

interface EditorPaneProps {
  workspaceId: string;
  file: OpenFile;
  theme: 'dark' | 'light';
  navigationLine: number | undefined;
  navigationKey: number;
  openPaths: string[];
  onChange: (path: string, content: string) => void;
  onSave: (path: string, content: string) => void;
  onCursorChange?: (line: number, column: number) => void;
}

export function EditorPane({
  workspaceId,
  file,
  theme,
  navigationLine,
  navigationKey,
  openPaths,
  onChange,
  onSave,
  onCursorChange,
}: EditorPaneProps) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const fileRef = useRef(file);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onCursorChangeRef = useRef(onCursorChange);
  const initialTheme = useRef(theme);
  const initialWorkspaceId = useRef(workspaceId);
  const suppressChange = useRef(false);

  fileRef.current = file;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onCursorChangeRef.current = onCursorChange;

  useEffect(() => {
    if (!container.current) return;
    const mountedWorkspaceId = initialWorkspaceId.current;
    const instance = monaco.editor.create(container.current, {
      automaticLayout: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 13,
      lineHeight: 21,
      minimap: { enabled: true },
      padding: { top: 12 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      renderWhitespace: 'selection',
      theme: initialTheme.current === 'dark' ? 'vs-dark' : 'vs',
    });
    editor.current = instance;
    const changeSubscription = instance.onDidChangeModelContent(() => {
      if (!suppressChange.current) onChangeRef.current(fileRef.current.path, instance.getValue());
    });
    const cursorSubscription = instance.onDidChangeCursorPosition(({ position }) =>
      onCursorChangeRef.current?.(position.lineNumber, position.column),
    );
    instance.addAction({
      id: 'forge.file.save',
      label: 'Guardar archivo',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => onSaveRef.current(fileRef.current.path, instance.getValue()),
    });
    return () => {
      changeSubscription.dispose();
      cursorSubscription.dispose();
      instance.dispose();
      for (const model of monaco.editor.getModels()) {
        if (model.uri.scheme === 'forge' && model.uri.authority === mountedWorkspaceId) {
          model.dispose();
        }
      }
    };
  }, []);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    const uri = monaco.Uri.from({ scheme: 'forge', authority: workspaceId, path: `/${file.path}` });
    let model = monaco.editor.getModel(uri);
    if (!model) model = monaco.editor.createModel(file.content, languageForPath(file.path), uri);
    instance.setModel(model);
    if (model.getValue() !== file.content) {
      suppressChange.current = true;
      model.setValue(file.content);
      suppressChange.current = false;
    }
    instance.focus();
  }, [file.content, file.path, workspaceId]);

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs');
  }, [theme]);

  useEffect(() => {
    const instance = editor.current;
    if (!instance || !navigationLine) return;
    instance.setPosition({ lineNumber: navigationLine, column: 1 });
    instance.revealLineInCenter(navigationLine);
  }, [navigationKey, navigationLine, file.path]);

  useEffect(() => {
    const activeUris = new Set(
      openPaths.map((path) =>
        monaco.Uri.from({ scheme: 'forge', authority: workspaceId, path: `/${path}` }).toString(),
      ),
    );
    for (const model of monaco.editor.getModels()) {
      if (
        model.uri.scheme === 'forge' &&
        model.uri.authority === workspaceId &&
        !activeUris.has(model.uri.toString())
      ) {
        model.dispose();
      }
    }
  }, [openPaths, workspaceId]);

  return <div className="monaco-host" ref={container} />;
}
