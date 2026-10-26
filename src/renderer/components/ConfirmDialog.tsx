interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <section className="modal confirm-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onCancel}>
            ×
          </button>
        </header>
        <p>{message}</p>
        <footer>
          <button className="secondary" onClick={onCancel}>
            Cancelar
          </button>
          <button className={danger ? 'danger-button' : 'primary compact'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
