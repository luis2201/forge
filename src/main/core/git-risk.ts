export type GitRiskOperation =
  | 'force-push'
  | 'hard-reset'
  | 'delete-branch'
  | 'discard'
  | 'checkout'
  | 'clean'
  | 'rebase'
  | 'merge'
  | 'pull';

export interface GitRiskContext {
  operation: GitRiskOperation;
  branch: string | null;
  repository: string;
  dirty: boolean;
  protectedBranches?: string[];
}

export interface GitRiskAssessment {
  level: 'SAFE' | 'WARNING' | 'DANGER';
  requiresConfirmation: boolean;
  consequences: string[];
}

export class GitRiskPolicy {
  assess(context: GitRiskContext): GitRiskAssessment {
    const protectedBranches = context.protectedBranches ?? ['main', 'master'];
    const protectedBranch = context.branch !== null && protectedBranches.includes(context.branch);
    if (['force-push', 'hard-reset', 'clean'].includes(context.operation)) {
      return {
        level: 'DANGER',
        requiresConfirmation: true,
        consequences: [
          'Puede eliminar commits o cambios que no sean recuperables desde la rama actual.',
          ...(protectedBranch ? [`La rama ${context.branch} se considera principal.`] : []),
        ],
      };
    }
    if (context.operation === 'delete-branch' || context.operation === 'discard') {
      return {
        level: 'DANGER',
        requiresConfirmation: true,
        consequences: ['Se perderán cambios o una referencia local de manera explícita.'],
      };
    }
    if (context.operation === 'rebase') {
      return {
        level: 'WARNING',
        requiresConfirmation: true,
        consequences: ['Reescribe los commits locales y puede requerir resolver conflictos.'],
      };
    }
    if ((context.operation === 'checkout' || context.operation === 'pull') && context.dirty) {
      return {
        level: 'WARNING',
        requiresConfirmation: true,
        consequences: ['Los cambios locales pueden impedir la operación o requerir resolución.'],
      };
    }
    return {
      level: context.operation === 'merge' ? 'WARNING' : 'SAFE',
      requiresConfirmation: context.operation === 'merge',
      consequences:
        context.operation === 'merge'
          ? ['Incorporará commits de otra rama y puede producir conflictos.']
          : [],
    };
  }
}
