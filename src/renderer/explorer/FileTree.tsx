import { useEffect, useState } from 'react';
import type { FileEntry, ForgeError } from '../../shared/contracts';
import type { SelectedEntry } from '../app/types';

interface FileTreeProps {
  workspaceId: string;
  refreshKey: number;
  selected: SelectedEntry;
  onSelect: (entry: SelectedEntry) => void;
  onOpen: (path: string) => void;
  onError: (error: ForgeError) => void;
}

export function FileTree(props: FileTreeProps) {
  return <DirectoryChildren {...props} directory="" depth={0} expanded />;
}

function DirectoryChildren({
  workspaceId,
  directory,
  depth,
  expanded,
  refreshKey,
  selected,
  onSelect,
  onOpen,
  onError,
}: FileTreeProps & { directory: string; depth: number; expanded: boolean }) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    let active = true;
    setLoading(true);
    void window.forge.file.list(workspaceId, directory).then((result) => {
      if (!active) return;
      setLoading(false);
      if (result.ok) setEntries(result.value);
      else onError(result.error);
    });
    return () => {
      active = false;
    };
  }, [directory, expanded, onError, refreshKey, workspaceId]);

  if (!expanded) return null;
  if (loading && entries.length === 0)
    return (
      <div className="tree-loading" style={{ paddingLeft: depth * 14 + 12 }}>
        Cargando…
      </div>
    );

  return (
    <>
      {entries.map((entry) => (
        <TreeEntry
          key={entry.path}
          entry={entry}
          depth={depth}
          workspaceId={workspaceId}
          refreshKey={refreshKey}
          selected={selected}
          onSelect={onSelect}
          onOpen={onOpen}
          onError={onError}
        />
      ))}
    </>
  );
}

function TreeEntry(
  props: Omit<FileTreeProps, 'workspaceId'> & {
    entry: FileEntry;
    depth: number;
    workspaceId: string;
  },
) {
  const { entry, depth, selected, onSelect, onOpen } = props;
  const [expanded, setExpanded] = useState(false);
  const isDirectory = entry.type === 'directory';
  const icon = isDirectory
    ? expanded
      ? '▾'
      : '▸'
    : entry.type === 'symlink'
      ? '↗'
      : fileIcon(entry.name);
  return (
    <div>
      <button
        className={`tree-entry ${selected.path === entry.path ? 'selected' : ''}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        title={entry.path}
        onClick={() => {
          onSelect({ path: entry.path, type: entry.type });
          if (isDirectory) setExpanded((value) => !value);
          else if (entry.type === 'file') onOpen(entry.path);
        }}
      >
        <span className={`tree-icon ${isDirectory ? 'folder' : ''}`}>{icon}</span>
        <span>{entry.name}</span>
      </button>
      {isDirectory && (
        <DirectoryChildren
          {...props}
          directory={entry.path}
          depth={depth + 1}
          expanded={expanded}
        />
      )}
    </div>
  );
}

function fileIcon(name: string): string {
  const extension = name.split('.').at(-1)?.toLocaleLowerCase();
  if (['ts', 'tsx', 'js', 'jsx'].includes(extension ?? '')) return '◇';
  if (['json', 'yaml', 'yml'].includes(extension ?? '')) return '{}';
  if (['md', 'txt'].includes(extension ?? '')) return '≡';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(extension ?? '')) return '▧';
  return '·';
}
