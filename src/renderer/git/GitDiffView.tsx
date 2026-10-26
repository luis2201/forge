import { useMemo } from 'react';
import type { GitDiff } from '../../shared/contracts';

const MAX_RENDERED_LINES = 10_000;

function lineKind(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-file';
  if (line.startsWith('+')) return 'diff-added';
  if (line.startsWith('-')) return 'diff-removed';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('commit ') ||
    line.startsWith('Author:') ||
    line.startsWith('Date:')
  )
    return 'diff-meta';
  return '';
}

export function GitDiffView({ diff }: { diff: GitDiff }) {
  const { lines, clipped } = useMemo(() => {
    const all = diff.content.split('\n');
    return {
      lines: all.slice(0, MAX_RENDERED_LINES),
      clipped: all.length > MAX_RENDERED_LINES,
    };
  }, [diff.content]);

  return (
    <section className="git-diff" aria-label="Diff de Git">
      {(diff.truncated || clipped) && (
        <div className="diff-warning">
          El diff es demasiado grande; Forge muestra una vista parcial segura.
        </div>
      )}
      <pre>
        {lines.map((line, index) => (
          <span className={lineKind(line)} key={`${index}-${line.slice(0, 32)}`}>
            <i>{index + 1}</i>
            <code>{line || ' '}</code>
          </span>
        ))}
      </pre>
    </section>
  );
}
