import type {
  GitIdentity,
  GitSensitiveFile,
  GitStatus,
  Recommendation,
} from '../../shared/contracts.js';
import type { DeterministicRule, RecommendationEngine } from './recommendations.js';

export interface GitAdvisorContext {
  repositoryPath: string;
  status: GitStatus;
  identity: GitIdentity;
  sensitiveFiles: GitSensitiveFile[];
}

const rules: readonly DeterministicRule<GitAdvisorContext>[] = [
  {
    id: 'conflicts',
    evaluate: ({ status, repositoryPath }) =>
      status.conflictCount > 0
        ? {
            severity: 'DANGER',
            title: 'Conflictos pendientes',
            message: `${status.conflictCount} archivo${status.conflictCount === 1 ? '' : 's'} requiere${status.conflictCount === 1 ? '' : 'n'} una resolución explícita.`,
            details: status.files
              .filter((file) => file.conflicted)
              .map((file) => `${file.path}: ${conflictLabel(file.conflictType)}`),
            actions: [
              {
                id: 'review-conflicts',
                label: 'Revisar conflictos',
                kind: 'navigate',
                command: 'git.reviewConflicts',
              },
            ],
            context: { repositoryPath, conflictCount: status.conflictCount },
          }
        : null,
  },
  {
    id: 'identity-missing',
    evaluate: ({ identity, repositoryPath }) => {
      if (identity.complete) return null;
      const missing = [!identity.name ? 'nombre' : null, !identity.email ? 'correo' : null].filter(
        (value): value is string => value !== null,
      );
      return {
        severity: 'WARNING',
        title: 'Falta la identidad Git',
        message: `Configura ${missing.join(' y ')} antes de crear commits.`,
        details: [
          'Git exige estos datos para identificar al autor; no son credenciales de GitHub.',
          'Forge puede guardarlos únicamente en este repositorio.',
        ],
        actions: [
          {
            id: 'configure-identity',
            label: 'Configurar identidad',
            kind: 'navigate',
            command: 'git.configureIdentity',
          },
        ],
        context: {
          repositoryPath,
          missingName: !identity.name,
          missingEmail: !identity.email,
        },
      };
    },
  },
  {
    id: 'initial-commit',
    evaluate: ({ status, repositoryPath }) =>
      status.head === null
        ? {
            severity: 'INFO',
            title: 'Primero crea el commit inicial',
            message: 'No hay ningún commit que pueda publicarse en el remoto.',
            details: ['Prepara los archivos, escribe un mensaje y confirma los cambios.'],
            context: {
              repositoryPath,
              stagedFiles: status.files.filter((file) => file.staged).length,
            },
          }
        : null,
  },
  {
    id: 'diverged',
    evaluate: ({ status, repositoryPath }) =>
      status.syncState === 'diverged'
        ? {
            severity: 'WARNING',
            title: 'Las ramas han divergido',
            message: `Tu rama contiene ${status.ahead} commit${status.ahead === 1 ? '' : 's'} que el remoto no posee, y el remoto contiene ${status.behind} que no existe${status.behind === 1 ? '' : 'n'} localmente.`,
            details: [
              'Revisa ambos historiales antes de elegir merge o rebase.',
              'Forge no integrará cambios automáticamente para comprobar el estado.',
            ],
            actions: [
              {
                id: 'compare-sync',
                label: 'Comparar cambios',
                kind: 'navigate',
                command: 'git.compareSync',
              },
              {
                id: 'resolve-sync',
                label: 'Resolver sincronización',
                kind: 'navigate',
                command: 'git.resolveSync',
              },
            ],
            context: { repositoryPath, ahead: status.ahead, behind: status.behind },
          }
        : null,
  },
  {
    id: 'dirty-behind',
    evaluate: ({ status, repositoryPath }) =>
      status.dirty && status.behind > 0 && status.syncState !== 'diverged'
        ? {
            severity: 'WARNING',
            title: 'Cambios locales antes de sincronizar',
            message: `Tienes cambios sin confirmar y el remoto contiene ${status.behind} commit${status.behind === 1 ? '' : 's'} pendiente${status.behind === 1 ? '' : 's'}.`,
            details: ['Confirma, descarta o guarda temporalmente tus cambios antes de hacer pull.'],
            context: { repositoryPath, behind: status.behind, dirty: true },
          }
        : null,
  },
  {
    id: 'no-remote',
    evaluate: ({ status, repositoryPath }) =>
      status.syncState === 'no-remote'
        ? {
            severity: 'INFO',
            title: 'Repositorio únicamente local',
            message: 'No hay remotos configurados. Puedes trabajar localmente o configurar origin.',
            actions: [
              {
                id: 'configure-remote',
                label: 'Configurar remoto',
                kind: 'navigate',
                command: 'git.configureRemote',
              },
            ],
            context: { repositoryPath },
          }
        : null,
  },
  {
    id: 'no-upstream',
    evaluate: ({ status, repositoryPath }) =>
      status.syncState === 'no-upstream' && status.head !== null
        ? {
            severity: 'INFO',
            title: 'Upstream no configurado',
            message: 'La rama actual todavía no está vinculada a una rama remota.',
            details: ['El primer push establecerá upstream cuando origin sea inequívoco.'],
            actions: [
              {
                id: 'push-upstream',
                label: 'Publicar rama',
                kind: 'command',
                command: 'git.push',
              },
            ],
            context: { repositoryPath, branch: status.branch },
          }
        : null,
  },
  {
    id: 'ahead',
    evaluate: ({ status, repositoryPath }) =>
      status.syncState === 'ahead'
        ? {
            severity: 'INFO',
            title: 'Commits pendientes de push',
            message: `Tu rama contiene ${status.ahead} commit${status.ahead === 1 ? '' : 's'} que todavía no existe${status.ahead === 1 ? '' : 'n'} en el remoto.`,
            actions: [
              {
                id: 'push',
                label: 'Publicar',
                kind: 'command',
                command: 'git.push',
              },
            ],
            context: { repositoryPath, ahead: status.ahead },
          }
        : null,
  },
  {
    id: 'behind',
    evaluate: ({ status, repositoryPath }) =>
      status.syncState === 'behind' && !status.dirty
        ? {
            severity: 'INFO',
            title: 'Commits pendientes de pull',
            message: `El remoto contiene ${status.behind} commit${status.behind === 1 ? '' : 's'} que todavía no existe${status.behind === 1 ? '' : 'n'} localmente.`,
            actions: [
              {
                id: 'fetch',
                label: 'Actualizar referencias',
                kind: 'command',
                command: 'git.fetch',
              },
            ],
            context: { repositoryPath, behind: status.behind },
          }
        : null,
  },
  {
    id: 'sensitive-staged',
    evaluate: ({ sensitiveFiles, repositoryPath }) => {
      const staged = sensitiveFiles.filter((file) => file.staged);
      return staged.length > 0
        ? {
            severity: 'DANGER',
            title: 'Posibles archivos sensibles preparados',
            message:
              'Revisa estos archivos antes de permitir el commit. Forge no inspecciona su contenido.',
            details: staged.map(
              (file) =>
                `${file.path} coincide con ${file.pattern}${file.ignoredByGit ? ' y fue agregado pese a .gitignore' : ''}`,
            ),
            actions: [
              {
                id: 'review-sensitive',
                label: 'Revisar archivos',
                kind: 'navigate',
                command: 'git.reviewSensitiveFiles',
              },
            ],
            context: { repositoryPath, fileCount: staged.length },
          }
        : null;
    },
  },
  {
    id: 'sensitive-untracked',
    evaluate: ({ sensitiveFiles, repositoryPath }) => {
      const exposed = sensitiveFiles.filter(
        (file) => file.untracked && !file.ignoredByGit && !file.staged,
      );
      return exposed.length > 0
        ? {
            severity: 'WARNING',
            title: 'Archivos sensibles sin excluir',
            message:
              'Hay archivos con nombres sensibles que no parecen estar cubiertos por .gitignore.',
            details: exposed.map((file) => `${file.path} coincide con ${file.pattern}`),
            context: { repositoryPath, fileCount: exposed.length },
          }
        : null;
    },
  },
  {
    id: 'stash',
    evaluate: ({ status, repositoryPath }) =>
      status.stashCount > 0
        ? {
            severity: 'INFO',
            title: 'Cambios guardados en stash',
            message: `El repositorio contiene ${status.stashCount} entrada${status.stashCount === 1 ? '' : 's'} de stash.`,
            context: { repositoryPath, stashCount: status.stashCount },
          }
        : null,
  },
];

export class GitAdvisor {
  constructor(private readonly engine: RecommendationEngine) {}

  advise(context: GitAdvisorContext): Recommendation[] {
    return this.engine.evaluate('git.advisor', context, rules);
  }
}

function conflictLabel(type: GitStatus['files'][number]['conflictType']): string {
  return (
    {
      'both-modified': 'modificado en ambos lados',
      'both-added': 'añadido en ambos lados',
      'both-deleted': 'eliminado en ambos lados',
      'added-by-us': 'añadido localmente',
      'added-by-them': 'añadido remotamente',
      'deleted-by-us': 'eliminado localmente',
      'deleted-by-them': 'eliminado remotamente',
    }[type ?? 'both-modified'] ?? 'conflicto'
  );
}
