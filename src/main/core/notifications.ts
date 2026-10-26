import type { Recommendation } from '../../shared/contracts.js';

export class NotificationCenter {
  private readonly recommendations = new Map<string, Recommendation[]>();

  replace(workspaceId: string, source: string, items: Recommendation[]): void {
    this.recommendations.set(`${workspaceId}\0${source}`, items);
  }

  list(workspaceId: string, source?: string): Recommendation[] {
    const prefix = `${workspaceId}\0`;
    return [...this.recommendations.entries()]
      .filter(([key]) => key.startsWith(prefix) && (!source || key === `${prefix}${source}`))
      .flatMap(([, items]) => items)
      .sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
  }

  clearWorkspace(workspaceId: string): void {
    const prefix = `${workspaceId}\0`;
    for (const key of this.recommendations.keys()) {
      if (key.startsWith(prefix)) this.recommendations.delete(key);
    }
  }
}

function severityRank(severity: Recommendation['severity']): number {
  return { INFO: 1, SUCCESS: 2, WARNING: 3, DANGER: 4 }[severity];
}
