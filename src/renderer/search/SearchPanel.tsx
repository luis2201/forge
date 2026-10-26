import { useState } from 'react';
import type { ForgeError, SearchResponse } from '../../shared/contracts';

interface SearchPanelProps {
  workspaceId: string;
  onOpen: (path: string, line: number) => void;
  onError: (error: ForgeError) => void;
}

export function SearchPanel({ workspaceId, onOpen, onError }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);

  const runSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    const result = await window.forge.search.text(workspaceId, query, caseSensitive);
    setSearching(false);
    if (result.ok) setResponse(result.value);
    else onError(result.error);
  };

  return (
    <div className="search-panel">
      <div className="search-controls">
        <div className="search-input-row">
          <input
            value={query}
            placeholder="Buscar en archivos"
            aria-label="Buscar en archivos"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runSearch();
            }}
          />
          <button
            className={caseSensitive ? 'toggle active' : 'toggle'}
            title="Distinguir mayúsculas"
            onClick={() => setCaseSensitive((value) => !value)}
          >
            Aa
          </button>
        </div>
        <button
          className="secondary full"
          disabled={searching || !query.trim()}
          onClick={() => void runSearch()}
        >
          {searching ? 'Buscando…' : 'Buscar'}
        </button>
      </div>
      {response && (
        <div className="search-summary">
          {response.results.length} resultados en {response.filesScanned} archivos
          {response.truncated ? ' · límite alcanzado' : ''}
        </div>
      )}
      <div className="search-results">
        {response?.results.map((result, index) => (
          <button
            className="search-result"
            key={`${result.path}:${result.line}:${result.column}:${index}`}
            onClick={() => onOpen(result.path, result.line)}
          >
            <strong>{result.path}</strong>
            <span>
              {result.line}:{result.column} · {result.preview || 'Línea vacía'}
            </span>
          </button>
        ))}
        {response && response.results.length === 0 && (
          <div className="search-empty">Sin coincidencias.</div>
        )}
      </div>
    </div>
  );
}
