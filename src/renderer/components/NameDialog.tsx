import { useEffect, useState } from 'react';

interface NameDialogProps {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function NameDialog({
  title,
  label,
  initialValue = '',
  confirmLabel,
  onConfirm,
  onCancel,
}: NameDialogProps) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => setValue(initialValue), [initialValue]);
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        className="modal name-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onConfirm(value.trim());
        }}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onCancel}>
            ×
          </button>
        </header>
        <label>
          {label}
          <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <footer>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="primary compact" disabled={!value.trim()}>
            {confirmLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
