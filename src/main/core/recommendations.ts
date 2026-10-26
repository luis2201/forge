import type {
  Recommendation,
  RecommendationAction,
  RecommendationSeverity,
} from '../../shared/contracts.js';

export interface RecommendationDraft {
  severity: RecommendationSeverity;
  title: string;
  message: string;
  details?: string[];
  actions?: RecommendationAction[];
  context?: Record<string, string | number | boolean | null>;
}

export interface DeterministicRule<TContext> {
  id: string;
  evaluate(context: TContext): RecommendationDraft | null;
}

export class RecommendationEngine {
  evaluate<TContext>(
    source: string,
    context: TContext,
    rules: readonly DeterministicRule<TContext>[],
  ): Recommendation[] {
    const timestamp = new Date().toISOString();
    return rules.flatMap((rule) => {
      const draft = rule.evaluate(context);
      if (!draft) return [];
      return [
        {
          id: `${source}:${rule.id}`,
          source,
          severity: draft.severity,
          title: draft.title,
          message: draft.message,
          details: draft.details ?? [],
          actions: draft.actions ?? [],
          timestamp,
          context: draft.context ?? {},
        },
      ];
    });
  }
}
