import { useEffect, useRef } from 'react';

interface Props {
  connectionId: string;
  value: string;
  theme: 'dark' | 'light';
  onChange: (value: string) => void;
  onExecute: () => void;
}

export function SqlEditor({ connectionId, value, theme, onChange, onExecute }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const initialValue = useRef(value);
  initialValue.current = value;
  const changeRef = useRef(onChange);
  const executeRef = useRef(onExecute);
  changeRef.current = onChange;
  executeRef.current = onExecute;

  useEffect(() => {
    let disposed = false;
    let cleanup = () => undefined;
    void import('../editor/monaco').then(({ monaco }) => {
      if (disposed || !container.current) return;
      const uri = monaco.Uri.parse(`forge://database/${connectionId}/query.sql`);
      const existing = monaco.editor.getModel(uri);
      const model = existing ?? monaco.editor.createModel(initialValue.current, 'sql', uri);
      if (model.getValue() !== initialValue.current) model.setValue(initialValue.current);
      const editor = monaco.editor.create(container.current, {
        model,
        theme: theme === 'dark' ? 'vs-dark' : 'vs',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        padding: { top: 10, bottom: 10 },
      });
      const change = model.onDidChangeContent(() => changeRef.current(model.getValue()));
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => executeRef.current());
      cleanup = () => {
        change.dispose();
        editor.dispose();
        if (!existing) model.dispose();
      };
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [connectionId, theme]);

  return <div className="sql-editor" ref={container} aria-label="Editor SQL" />;
}
