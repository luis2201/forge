import { useCallback, useEffect, useState } from 'react';
import type {
  DatabaseColumn,
  DatabaseHistoryEntry,
  DatabaseImportPreview,
  DatabaseQueryResult,
  DatabaseRowMutation,
  DatabaseTableData,
  DatabaseTableStructure,
  DatabaseValue,
  ForgeError,
} from '../../shared/contracts';
import type { DatabaseSelection } from './DatabaseSidebar';
import { SqlEditor } from './SqlEditor';

interface Confirmation {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => void;
}

interface Props {
  workspaceId: string;
  selection: DatabaseSelection | null;
  theme: 'dark' | 'light';
  onError: (error: ForgeError) => void;
  onConfirm: (confirmation: Confirmation) => void;
}

type WorkbenchTab = 'query' | 'data' | 'structure' | 'history';

interface RowDraft {
  mode: 'insert' | 'update';
  rowIndex: number | null;
  values: Record<string, string>;
  initialValues: Record<string, string>;
  nulls: Record<string, boolean>;
  initialNulls: Record<string, boolean>;
  included: Record<string, boolean>;
  original: Record<string, DatabaseValue> | null;
}

export function DatabaseWorkbench({ workspaceId, selection, theme, onError, onConfirm }: Props) {
  const [tab, setTab] = useState<WorkbenchTab>('query');
  const [statement, setStatement] = useState('SELECT 1 AS forge_ready;');
  const [queryResult, setQueryResult] = useState<DatabaseQueryResult | null>(null);
  const [tableData, setTableData] = useState<DatabaseTableData | null>(null);
  const [structure, setStructure] = useState<DatabaseTableStructure | null>(null);
  const [history, setHistory] = useState<DatabaseHistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [rowDraft, setRowDraft] = useState<RowDraft | null>(null);
  const [importPreview, setImportPreview] = useState<DatabaseImportPreview | null>(null);

  const connection = selection?.connection ?? null;
  const object = selection?.object ?? null;

  useEffect(() => {
    setQueryResult(null);
    setTableData(null);
    setStructure(null);
    setRowDraft(null);
    setImportPreview(null);
  }, [connection?.id, object?.schema, object?.name]);

  const loadStructure = useCallback(async () => {
    if (!connection || !object) return;
    setBusy(true);
    const response = await window.forge.database.structure(
      workspaceId,
      connection.id,
      object.schema,
      object.name,
    );
    setBusy(false);
    if (!response.ok) return onError(response.error);
    setStructure(response.value);
  }, [connection, object, onError, workspaceId]);

  const loadData = useCallback(
    async (offset = 0) => {
      if (!connection || !object) return;
      setBusy(true);
      const response = await window.forge.database.tableData(
        workspaceId,
        connection.id,
        object.schema,
        object.name,
        offset,
        200,
      );
      setBusy(false);
      if (!response.ok) return onError(response.error);
      setTableData(response.value);
      setStructure(response.value.structure);
      setRowDraft(null);
    },
    [connection, object, onError, workspaceId],
  );

  const loadHistory = useCallback(async () => {
    const response = await window.forge.database.history(workspaceId, 200);
    if (!response.ok) return onError(response.error);
    setHistory(response.value);
  }, [onError, workspaceId]);

  useEffect(() => {
    if (tab === 'data' && object && !tableData) void loadData();
    if (tab === 'structure' && object && !structure) void loadStructure();
    if (tab === 'history') void loadHistory();
  }, [loadData, loadHistory, loadStructure, object, structure, tab, tableData]);

  useEffect(() => {
    if (object) setTab('data');
  }, [object]);

  const execute = async (confirmed = false) => {
    if (!connection || !statement.trim()) return;
    setBusy(true);
    const response = await window.forge.database.query(
      workspaceId,
      connection.id,
      statement,
      confirmed,
    );
    setBusy(false);
    if (!response.ok) {
      if (
        !confirmed &&
        ['DATABASE_CONFIRMATION_REQUIRED', 'DATABASE_PRODUCTION_CONFIRMATION_REQUIRED'].includes(
          response.error.code,
        )
      ) {
        return onConfirm({
          title: response.error.code.includes('PRODUCTION')
            ? 'Ejecutar SQL en producción'
            : 'Confirmar sentencia SQL',
          message: `${response.error.message}\n\n${response.error.remediation?.join('\n') ?? ''}`,
          confirmLabel: 'Ejecutar SQL',
          danger: true,
          action: () => void execute(true),
        });
      }
      return onError(response.error);
    }
    setQueryResult(response.value);
    void loadHistory();
  };

  const mutate = async (mutation: DatabaseRowMutation, confirmed = false) => {
    if (!connection || !object) return;
    setBusy(true);
    const response = await window.forge.database.mutateRow(
      workspaceId,
      connection.id,
      object.schema,
      object.name,
      mutation,
      confirmed,
    );
    setBusy(false);
    if (!response.ok) {
      if (
        !confirmed &&
        ['DATABASE_CONFIRMATION_REQUIRED', 'DATABASE_PRODUCTION_CONFIRMATION_REQUIRED'].includes(
          response.error.code,
        )
      ) {
        return onConfirm({
          title: 'Confirmar modificación de datos',
          message: response.error.message,
          confirmLabel: mutation.kind === 'delete' ? 'Eliminar fila' : 'Modificar datos',
          danger: true,
          action: () => void mutate(mutation, true),
        });
      }
      return onError(response.error);
    }
    setRowDraft(null);
    await loadData(tableData?.offset ?? 0);
  };

  const invalidRow = (message: string) =>
    onError({
      code: 'DATABASE_INVALID_ROW_VALUES',
      message,
      correlationId: crypto.randomUUID(),
    });

  const submitDraft = () => {
    if (!rowDraft || !structure) return;
    const parsed = parseDraftValues(rowDraft, structure.columns);
    if (!parsed.ok) return invalidRow(parsed.message);
    if (rowDraft.mode === 'insert') {
      void mutate({ kind: 'insert', values: parsed.values });
      return;
    }
    if (!rowDraft.original) return;
    if (Object.keys(parsed.values).length === 0) {
      invalidRow('No hay cambios para guardar en esta fila.');
      return;
    }
    void mutate({
      kind: 'update',
      values: parsed.values,
      key: primaryKeyFor(structure, rowDraft.original),
    });
  };

  const deleteRecord = (record: Record<string, DatabaseValue>) => {
    if (!structure) return;
    onConfirm({
      title: 'Eliminar fila',
      message: `Se eliminará una fila de ${structure.schema}.${structure.name} usando su clave primaria.`,
      confirmLabel: 'Eliminar fila',
      danger: true,
      action: () => void mutate({ kind: 'delete', key: primaryKeyFor(structure, record) }, true),
    });
  };

  const exportRows = async (format: 'csv' | 'json', result: DatabaseQueryResult) => {
    if (!connection) return;
    const response = await window.forge.database.exportResult(
      workspaceId,
      connection.id,
      format,
      object?.name ?? 'forge-query',
      result.columns.map((column) => column.name),
      result.rows,
    );
    if (!response.ok) onError(response.error);
  };

  const previewImport = async () => {
    const response = await window.forge.database.previewImport(workspaceId);
    if (!response.ok) return onError(response.error);
    if (response.value) setImportPreview(response.value);
  };

  const applyImport = async (confirmed = false) => {
    if (!connection || !object || !importPreview) return;
    setBusy(true);
    const response = await window.forge.database.applyImport(
      workspaceId,
      connection.id,
      importPreview.importId,
      object.schema,
      object.name,
      confirmed,
    );
    setBusy(false);
    if (!response.ok) {
      if (!confirmed && response.error.code === 'DATABASE_PRODUCTION_CONFIRMATION_REQUIRED') {
        return onConfirm({
          title: 'Importar datos en producción',
          message: response.error.message,
          confirmLabel: `Importar ${importPreview.totalRows} filas`,
          danger: true,
          action: () => void applyImport(true),
        });
      }
      return onError(response.error);
    }
    setImportPreview(null);
    await loadData(0);
  };

  if (!connection) {
    return (
      <div className="database-welcome">
        <span className="database-welcome-icon">DB</span>
        <h2>Bases de datos</h2>
        <p>Selecciona o crea una conexión para consultar datos sin abandonar Forge.</p>
        <ul>
          <li>MySQL, PostgreSQL y SQLite</li>
          <li>Credenciales cifradas por Windows</li>
          <li>Confirmaciones reforzadas para producción</li>
        </ul>
      </div>
    );
  }

  return (
    <div className="database-workbench">
      <header className="database-workbench-header">
        <div>
          <span className={`database-engine engine-${connection.engine}`}>
            {connection.engine === 'sqlite' ? 'S' : connection.engine === 'mysql' ? 'M' : 'P'}
          </span>
          <span>
            <strong>{connection.name}</strong>
            <small>
              {connection.engine === 'sqlite'
                ? connection.sqlitePath
                : `${connection.username}@${connection.host}:${connection.port ?? ''}/${connection.database}`}
            </small>
          </span>
        </div>
        <span className={`environment environment-${connection.environment.toLowerCase()}`}>
          {connection.environment}
        </span>
      </header>
      <nav className="database-tabs" aria-label="Herramientas de base de datos">
        <button className={tab === 'query' ? 'active' : ''} onClick={() => setTab('query')}>
          Consulta SQL
        </button>
        <button
          className={tab === 'data' ? 'active' : ''}
          disabled={!object}
          onClick={() => setTab('data')}
        >
          Datos
        </button>
        <button
          className={tab === 'structure' ? 'active' : ''}
          disabled={!object}
          onClick={() => setTab('structure')}
        >
          Estructura
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          Historial SQL
        </button>
      </nav>

      {tab === 'query' && (
        <section className="database-query-view">
          <div className="database-toolbar">
            <button
              className="primary"
              disabled={busy || !statement.trim()}
              onClick={() => void execute()}
            >
              {busy ? 'Ejecutando…' : '▶ Ejecutar'}
            </button>
            <span>Ctrl+Enter</span>
            {queryResult && (
              <>
                <div className="spacer" />
                <button onClick={() => void exportRows('csv', queryResult)}>Exportar CSV</button>
                <button onClick={() => void exportRows('json', queryResult)}>Exportar JSON</button>
              </>
            )}
          </div>
          <SqlEditor
            connectionId={connection.id}
            value={statement}
            theme={theme}
            onChange={setStatement}
            onExecute={() => void execute()}
          />
          <ResultPane result={queryResult} />
        </section>
      )}

      {tab === 'data' && object && (
        <section className="database-data-view">
          <div className="database-toolbar">
            <strong>
              {object.schema}.{object.name}
            </strong>
            <span>{object.type === 'view' ? 'Vista · sólo lectura' : 'Tabla'}</span>
            <div className="spacer" />
            {object.type === 'table' && (
              <>
                <button
                  disabled={!structure || Boolean(rowDraft) || busy}
                  onClick={() => structure && setRowDraft(createInsertDraft(structure.columns))}
                >
                  ＋ Añadir fila
                </button>
                <button onClick={() => void previewImport()}>Importar</button>
              </>
            )}
            {tableData && (
              <>
                <button onClick={() => void exportRows('csv', tableData.result)}>CSV</button>
                <button onClick={() => void exportRows('json', tableData.result)}>JSON</button>
              </>
            )}
            <button onClick={() => void loadData(tableData?.offset ?? 0)}>↻</button>
          </div>
          <EditableDataGrid
            result={tableData?.result ?? null}
            structure={structure}
            draft={rowDraft}
            busy={busy}
            onDraftChange={setRowDraft}
            onEdit={(rowIndex, record) =>
              structure && setRowDraft(createUpdateDraft(structure.columns, rowIndex, record))
            }
            onDelete={deleteRecord}
            onSave={submitDraft}
            onCancel={() => setRowDraft(null)}
          />
          {tableData && (
            <footer className="database-pagination">
              <button
                disabled={tableData.offset === 0}
                onClick={() => void loadData(Math.max(0, tableData.offset - tableData.limit))}
              >
                ← Anterior
              </button>
              <span>
                Filas {tableData.offset + 1}–{tableData.offset + tableData.result.rows.length}
              </span>
              <button
                disabled={!tableData.result.truncated}
                onClick={() => void loadData(tableData.offset + tableData.limit)}
              >
                Siguiente →
              </button>
            </footer>
          )}
        </section>
      )}

      {tab === 'structure' && object && (
        <section className="database-structure-view">
          <div className="database-toolbar">
            <strong>
              Estructura de {object.schema}.{object.name}
            </strong>
            <div className="spacer" />
            <button onClick={() => void loadStructure()}>↻ Actualizar</button>
          </div>
          {structure ? (
            <>
              <table>
                <thead>
                  <tr>
                    <th>Columna</th>
                    <th>Tipo</th>
                    <th>Nulo</th>
                    <th>Clave</th>
                    <th>Predeterminado</th>
                  </tr>
                </thead>
                <tbody>
                  {structure.columns.map((column) => (
                    <tr key={column.name}>
                      <td>
                        <strong>{column.name}</strong>
                        {column.generated && <small> generada</small>}
                        {column.autoIncrement && <small> autoincremental</small>}
                      </td>
                      <td>{column.dataType}</td>
                      <td>{column.nullable ? 'Sí' : 'No'}</td>
                      <td>{column.primaryKey ? 'PRIMARY' : ''}</td>
                      <td>{column.defaultValue ?? <i>—</i>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {structure.foreignKeys.length > 0 && (
                <div className="database-foreign-keys">
                  <h3>Claves foráneas</h3>
                  {structure.foreignKeys.map((key) => (
                    <div key={`${key.column}-${key.referencedTable}`}>
                      <strong>{key.column}</strong>
                      <span>
                        → {key.referencedSchema}.{key.referencedTable}.{key.referencedColumn}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="database-loading">
              {busy ? 'Leyendo estructura…' : 'Sin estructura disponible.'}
            </div>
          )}
        </section>
      )}

      {tab === 'history' && (
        <section className="database-history-view">
          <div className="database-toolbar">
            <strong>Historial SQL del workspace</strong>
            <div className="spacer" />
            <button onClick={() => void loadHistory()}>↻ Actualizar</button>
            <button
              className="danger-text"
              disabled={history.length === 0}
              onClick={() =>
                onConfirm({
                  title: 'Limpiar historial SQL',
                  message: 'Se eliminará el historial SQL local de este workspace.',
                  confirmLabel: 'Limpiar historial',
                  danger: true,
                  action: () => {
                    void window.forge.database.clearHistory(workspaceId, true).then((response) => {
                      if (!response.ok) onError(response.error);
                      else void loadHistory();
                    });
                  },
                })
              }
            >
              Limpiar
            </button>
          </div>
          <div className="database-history-list">
            {history.map((entry) => (
              <button
                key={entry.id}
                onClick={() => {
                  setStatement(entry.statement);
                  setTab('query');
                }}
              >
                <i className={entry.succeeded ? 'success' : 'failed'} />
                <span>
                  <strong>{entry.statement}</strong>
                  <small>
                    {entry.connectionName} · {entry.durationMs} ms · {entry.rowCount} filas
                  </small>
                </span>
                <time>{new Date(entry.executedAt).toLocaleString()}</time>
              </button>
            ))}
            {history.length === 0 && (
              <div className="database-empty">
                <span>Aún no hay consultas en el historial.</span>
              </div>
            )}
          </div>
        </section>
      )}

      {importPreview && object && (
        <ImportDialog
          preview={importPreview}
          target={`${object.schema}.${object.name}`}
          busy={busy}
          onClose={() => setImportPreview(null)}
          onApply={() => void applyImport()}
        />
      )}
    </div>
  );
}

function ResultPane({ result }: { result: DatabaseQueryResult | null }) {
  if (!result)
    return (
      <div className="database-result-empty">Ejecuta una consulta para ver los resultados.</div>
    );
  if (result.kind === 'mutation') {
    return (
      <div className="database-mutation-result">
        <strong>Operación completada</strong>
        <span>
          {result.affectedRows} fila{result.affectedRows === 1 ? '' : 's'} afectada
          {result.affectedRows === 1 ? '' : 's'} · {result.durationMs} ms
        </span>
      </div>
    );
  }
  return (
    <div className="database-result-pane">
      <div className="database-result-meta">
        <span>
          {result.rowCount} filas · {result.durationMs} ms
        </span>
        {result.truncated && <strong>Resultado limitado a 1000 filas</strong>}
      </div>
      <div className="database-grid-scroll">
        <table className="database-grid">
          <thead>
            <tr>
              <th>#</th>
              {result.columns.map((column, index) => (
                <th key={`${column.name}-${index}`} title={column.dataType}>
                  {column.name}
                  <small>{column.dataType}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <td>{rowIndex + 1}</td>
                {row.map((value, columnIndex) => (
                  <td key={columnIndex} title={value === null ? 'NULL' : String(value)}>
                    {value === null ? (
                      <i>NULL</i>
                    ) : typeof value === 'boolean' ? (
                      String(value)
                    ) : (
                      value
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EditableDataGrid({
  result,
  structure,
  draft,
  busy,
  onDraftChange,
  onEdit,
  onDelete,
  onSave,
  onCancel,
}: {
  result: DatabaseQueryResult | null;
  structure: DatabaseTableStructure | null;
  draft: RowDraft | null;
  busy: boolean;
  onDraftChange: (draft: RowDraft) => void;
  onEdit: (rowIndex: number, record: Record<string, DatabaseValue>) => void;
  onDelete: (record: Record<string, DatabaseValue>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (!result || !structure) {
    return <div className="database-result-empty">Cargando datos de la tabla…</div>;
  }
  const hasPrimaryKey = structure.columns.some((column) => column.primaryKey);
  return (
    <div className="database-result-pane database-editable-result">
      <div className="database-result-meta">
        <span>
          {result.rowCount} filas · {result.durationMs} ms
        </span>
        {!hasPrimaryKey && structure.type === 'table' && (
          <strong>Edición y eliminación requieren clave primaria</strong>
        )}
      </div>
      <div className="database-grid-scroll">
        <table className="database-grid database-editable-grid">
          <thead>
            <tr>
              <th>#</th>
              {result.columns.map((column, index) => {
                const metadata = structure.columns.find((item) => item.name === column.name);
                return (
                  <th key={`${column.name}-${index}`} title={metadata?.dataType ?? column.dataType}>
                    {column.name}
                    <small>{metadata?.dataType ?? column.dataType}</small>
                  </th>
                );
              })}
              {structure.type === 'table' && <th className="database-actions-column">Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {draft?.mode === 'insert' && (
              <EditableRow
                result={result}
                structure={structure}
                draft={draft}
                busy={busy}
                onDraftChange={onDraftChange}
                onSave={onSave}
                onCancel={onCancel}
              />
            )}
            {result.rows.map((row, rowIndex) => {
              const record = recordFromRow(result, row);
              if (draft?.mode === 'update' && draft.rowIndex === rowIndex) {
                return (
                  <EditableRow
                    key={rowIndex}
                    result={result}
                    structure={structure}
                    draft={draft}
                    busy={busy}
                    onDraftChange={onDraftChange}
                    onSave={onSave}
                    onCancel={onCancel}
                  />
                );
              }
              const safelyIdentified = hasCompletePrimaryKey(structure, record);
              return (
                <tr key={rowIndex}>
                  <td>{rowIndex + 1}</td>
                  {row.map((value, columnIndex) => (
                    <td key={columnIndex} title={value === null ? 'NULL' : String(value)}>
                      {value === null ? <i>NULL</i> : String(value)}
                    </td>
                  ))}
                  {structure.type === 'table' && (
                    <td className="database-row-actions">
                      <button
                        aria-label={`Editar fila ${rowIndex + 1}`}
                        title={safelyIdentified ? 'Editar fila' : 'Requiere clave primaria'}
                        disabled={busy || Boolean(draft) || !safelyIdentified}
                        onClick={() => onEdit(rowIndex, record)}
                      >
                        Editar
                      </button>
                      <button
                        className="danger-text"
                        aria-label={`Eliminar fila ${rowIndex + 1}`}
                        title={safelyIdentified ? 'Eliminar fila' : 'Requiere clave primaria'}
                        disabled={busy || Boolean(draft) || !safelyIdentified}
                        onClick={() => onDelete(record)}
                      >
                        Eliminar
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EditableRow({
  result,
  structure,
  draft,
  busy,
  onDraftChange,
  onSave,
  onCancel,
}: {
  result: DatabaseQueryResult;
  structure: DatabaseTableStructure;
  draft: RowDraft;
  busy: boolean;
  onDraftChange: (draft: RowDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const label = draft.mode === 'insert' ? 'fila nueva' : `fila ${(draft.rowIndex ?? 0) + 1}`;
  return (
    <tr className="database-draft-row">
      <td>{draft.mode === 'insert' ? 'Nueva' : (draft.rowIndex ?? 0) + 1}</td>
      {result.columns.map((resultColumn) => {
        const column = structure.columns.find((item) => item.name === resultColumn.name);
        return (
          <td key={resultColumn.name}>
            {column ? (
              <DatabaseCellEditor
                column={column}
                draft={draft}
                label={`${column.name} de ${label}`}
                onChange={onDraftChange}
              />
            ) : (
              <span className="database-generated-value">No editable</span>
            )}
          </td>
        );
      })}
      <td className="database-row-actions database-draft-actions">
        <button className="primary" disabled={busy} onClick={onSave}>
          {busy ? 'Guardando…' : draft.mode === 'insert' ? 'Guardar fila' : 'Guardar cambios'}
        </button>
        <button disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
      </td>
    </tr>
  );
}

function DatabaseCellEditor({
  column,
  draft,
  label,
  onChange,
}: {
  column: DatabaseColumn;
  draft: RowDraft;
  label: string;
  onChange: (draft: RowDraft) => void;
}) {
  const included = draft.included[column.name] ?? false;
  const isNull = draft.nulls[column.name] ?? false;
  const value = draft.values[column.name] ?? '';
  const kind = databaseInputKind(column.dataType);
  const enumValues = parseEnumValues(column.dataType);
  const update = (change: Partial<Pick<RowDraft, 'values' | 'nulls' | 'included'>>) =>
    onChange({ ...draft, ...change });

  if (column.generated || (draft.mode === 'insert' && column.autoIncrement)) {
    return (
      <span className="database-generated-value">
        {column.autoIncrement ? 'Automático' : 'Generada'}
      </span>
    );
  }
  if (!included) {
    const source = column.defaultValue !== null ? `DEFAULT ${column.defaultValue}` : 'NULL';
    return (
      <button
        className="database-use-value"
        aria-label={`Usar valor para ${label}`}
        title={`La base de datos usará ${source}`}
        onClick={() => update({ included: { ...draft.included, [column.name]: true } })}
      >
        <span>Usar valor</span>
        <small>{source}</small>
      </button>
    );
  }

  const common = {
    'aria-label': label,
    disabled: isNull,
    value,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      update({ values: { ...draft.values, [column.name]: event.target.value } }),
  };
  const canOmit = draft.mode === 'insert' && (column.defaultValue !== null || column.nullable);
  return (
    <div className="database-cell-editor">
      {enumValues.length > 0 ? (
        <select {...common}>
          {enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : kind === 'boolean' ? (
        <select {...common}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          {...common}
          type={kind === 'integer' || kind === 'decimal' ? 'number' : kind}
          step={kind === 'integer' ? '1' : kind === 'decimal' ? 'any' : undefined}
          min={/unsigned/i.test(column.dataType) ? '0' : undefined}
          maxLength={characterLimit(column.dataType)}
          spellCheck={kind === 'text'}
        />
      )}
      <div className="database-cell-options">
        {column.nullable && (
          <button
            className={isNull ? 'active' : ''}
            aria-label={`Usar NULL para ${label}`}
            aria-pressed={isNull}
            title="Guardar NULL"
            onClick={() => update({ nulls: { ...draft.nulls, [column.name]: !isNull } })}
          >
            NULL
          </button>
        )}
        {canOmit && (
          <button
            aria-label={`Omitir ${label}`}
            title="Omitir y usar el valor predeterminado de la base"
            onClick={() => update({ included: { ...draft.included, [column.name]: false } })}
          >
            Omitir
          </button>
        )}
      </div>
    </div>
  );
}

function createInsertDraft(columns: DatabaseColumn[]): RowDraft {
  const included = Object.fromEntries(
    columns.map((column) => [
      column.name,
      !column.generated &&
        !column.autoIncrement &&
        column.defaultValue === null &&
        !column.nullable,
    ]),
  );
  const values = Object.fromEntries(
    columns.map((column) => [column.name, initialColumnValue(column)]),
  );
  const nulls = Object.fromEntries(columns.map((column) => [column.name, false]));
  return {
    mode: 'insert',
    rowIndex: null,
    values,
    initialValues: { ...values },
    nulls,
    initialNulls: { ...nulls },
    included,
    original: null,
  };
}

function createUpdateDraft(
  columns: DatabaseColumn[],
  rowIndex: number,
  record: Record<string, DatabaseValue>,
): RowDraft {
  const values = Object.fromEntries(
    columns.map((column) => [
      column.name,
      displayDatabaseValue(record[column.name] ?? null, column),
    ]),
  );
  const nulls = Object.fromEntries(
    columns.map((column) => [column.name, (record[column.name] ?? null) === null]),
  );
  return {
    mode: 'update',
    rowIndex,
    values,
    initialValues: { ...values },
    nulls,
    initialNulls: { ...nulls },
    included: Object.fromEntries(columns.map((column) => [column.name, !column.generated])),
    original: record,
  };
}

function parseDraftValues(
  draft: RowDraft,
  columns: DatabaseColumn[],
): { ok: true; values: Record<string, DatabaseValue> } | { ok: false; message: string } {
  const values: Record<string, DatabaseValue> = {};
  for (const column of columns) {
    if (column.generated || !draft.included[column.name]) continue;
    const changed =
      draft.mode === 'insert' ||
      draft.values[column.name] !== draft.initialValues[column.name] ||
      draft.nulls[column.name] !== draft.initialNulls[column.name];
    if (!changed) continue;
    if (draft.nulls[column.name]) {
      if (!column.nullable) return { ok: false, message: `${column.name} no admite NULL.` };
      values[column.name] = null;
      continue;
    }
    const raw = draft.values[column.name] ?? '';
    const kind = databaseInputKind(column.dataType);
    if (kind === 'boolean') {
      values[column.name] = raw === 'true';
    } else if (kind === 'integer') {
      if (!/^-?\d+$/u.test(raw))
        return { ok: false, message: `${column.name} requiere un número entero.` };
      const numeric = Number(raw);
      values[column.name] = Number.isSafeInteger(numeric) ? numeric : raw;
    } else if (kind === 'decimal') {
      if (raw.trim() === '' || !Number.isFinite(Number(raw)))
        return { ok: false, message: `${column.name} requiere un número válido.` };
      values[column.name] = raw;
    } else if (kind === 'date' || kind === 'time' || kind === 'datetime-local') {
      if (!raw) return { ok: false, message: `${column.name} requiere una fecha u hora válida.` };
      values[column.name] = kind === 'datetime-local' ? raw.replace('T', ' ') : raw;
    } else if (kind === 'json') {
      try {
        JSON.parse(raw);
        values[column.name] = raw;
      } catch {
        return { ok: false, message: `${column.name} requiere JSON válido.` };
      }
    } else {
      values[column.name] = raw;
    }
  }
  return { ok: true, values };
}

type DatabaseInputKind =
  'text' | 'integer' | 'decimal' | 'boolean' | 'date' | 'time' | 'datetime-local' | 'json';

function databaseInputKind(dataType: string): DatabaseInputKind {
  const type = dataType.toLowerCase();
  if (/\b(bool|boolean)\b/u.test(type) || /tinyint\s*\(\s*1\s*\)/u.test(type)) return 'boolean';
  if (/\b(json|jsonb)\b/u.test(type)) return 'json';
  if (/\b(timestamp|datetime)\b/u.test(type)) return 'datetime-local';
  if (/\bdate\b/u.test(type)) return 'date';
  if (/\btime\b/u.test(type)) return 'time';
  if (/\b(int|integer|bigint|smallint|serial|bigserial|smallserial)\b/u.test(type))
    return 'integer';
  if (/\b(decimal|numeric|real|float|double|money)\b/u.test(type)) return 'decimal';
  return 'text';
}

function parseEnumValues(dataType: string): string[] {
  const match = dataType.match(/^enum\((.*)\)$/iu);
  if (!match?.[1]) return [];
  return [...match[1].matchAll(/'((?:''|\\'|[^'])*)'/gu)].map((item) =>
    (item[1] ?? '').replace(/''|\\'/gu, "'"),
  );
}

function characterLimit(dataType: string): number | undefined {
  const match = dataType.match(/(?:var)?char\s*\(\s*(\d+)\s*\)/iu);
  return match?.[1] ? Number(match[1]) : undefined;
}

function initialColumnValue(column: DatabaseColumn): string {
  const kind = databaseInputKind(column.dataType);
  if (kind === 'boolean') return 'false';
  const enumValues = parseEnumValues(column.dataType);
  return enumValues[0] ?? '';
}

function displayDatabaseValue(value: DatabaseValue, column: DatabaseColumn): string {
  if (value === null) return initialColumnValue(column);
  const kind = databaseInputKind(column.dataType);
  if (kind === 'boolean') return value === true || value === 1 || value === '1' ? 'true' : 'false';
  if (kind === 'datetime-local') return String(value).replace(' ', 'T').slice(0, 16);
  return String(value);
}

function recordFromRow(
  result: DatabaseQueryResult,
  row: DatabaseValue[],
): Record<string, DatabaseValue> {
  return Object.fromEntries(
    result.columns.map((column, index) => [column.name, row[index] ?? null]),
  );
}

function primaryKeyFor(
  structure: DatabaseTableStructure,
  record: Record<string, DatabaseValue>,
): Record<string, DatabaseValue> {
  return Object.fromEntries(
    structure.columns
      .filter((column) => column.primaryKey)
      .map((column) => [column.name, record[column.name] ?? null]),
  );
}

function hasCompletePrimaryKey(
  structure: DatabaseTableStructure,
  record: Record<string, DatabaseValue>,
): boolean {
  const keys = structure.columns.filter((column) => column.primaryKey);
  return keys.length > 0 && keys.every((column) => column.name in record);
}

function ImportDialog({
  preview,
  target,
  busy,
  onClose,
  onApply,
}: {
  preview: DatabaseImportPreview;
  target: string;
  busy: boolean;
  onClose: () => void;
  onApply: () => void;
}) {
  const result: DatabaseQueryResult = {
    kind: 'rows',
    columns: preview.columns.map((name) => ({ name, dataType: preview.format.toUpperCase() })),
    rows: preview.rows,
    rowCount: preview.rows.length,
    affectedRows: 0,
    durationMs: 0,
    truncated: preview.truncated,
    command: 'IMPORT PREVIEW',
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal database-import-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>Importar {preview.fileName}</h2>
            <p>
              {preview.totalRows} filas hacia {target}
            </p>
          </div>
          <button className="icon-button" onClick={onClose}>
            ×
          </button>
        </header>
        <ResultPane result={result} />
        <footer>
          <span>La importación usa una transacción: un error revierte todas las filas.</span>
          <div>
            <button onClick={onClose}>Cancelar</button>
            <button className="primary" disabled={busy} onClick={onApply}>
              {busy ? 'Importando…' : `Importar ${preview.totalRows} filas`}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
