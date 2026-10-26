import { describe, expect, it } from 'vitest';
import { GitAdvisor } from '../../src/main/core/git-advisor';
import { GitRiskPolicy } from '../../src/main/core/git-risk';
import { NotificationCenter } from '../../src/main/core/notifications';
import { RecommendationEngine } from '../../src/main/core/recommendations';
import type { GitStatus } from '../../src/shared/contracts';

const identity = {
  name: 'Forge Test',
  email: 'forge@example.test',
  complete: true,
};

const status = (patch: Partial<GitStatus> = {}): GitStatus => ({
  branch: 'main',
  head: '1'.repeat(40),
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  remoteHead: '1'.repeat(40),
  syncState: 'synchronized',
  dirty: false,
  conflictCount: 0,
  stashCount: 0,
  lastCommit: null,
  lastRemoteCommit: null,
  remotes: [],
  operation: null,
  files: [],
  ...patch,
});

describe('Recommendation and risk engines', () => {
  it('evaluates deterministic Git rules with structured actions and context', () => {
    const advisor = new GitAdvisor(new RecommendationEngine());
    const recommendations = advisor.advise({
      repositoryPath: '',
      status: status({ syncState: 'diverged', ahead: 2, behind: 3 }),
      identity,
      sensitiveFiles: [],
    });

    expect(recommendations).toEqual([
      expect.objectContaining({
        id: 'git.advisor:diverged',
        source: 'git.advisor',
        severity: 'WARNING',
        context: { repositoryPath: '', ahead: 2, behind: 3 },
      }),
    ]);
    expect(recommendations[0]?.actions).toEqual([
      expect.objectContaining({ command: 'git.compareSync' }),
      expect.objectContaining({ command: 'git.resolveSync' }),
    ]);
  });

  it('prioritizes conflicts and sensitive staged files without any AI dependency', () => {
    const advisor = new GitAdvisor(new RecommendationEngine());
    const recommendations = advisor.advise({
      repositoryPath: '',
      status: status({
        syncState: 'conflicted',
        conflictCount: 1,
        dirty: true,
        files: [
          {
            path: 'app.ts',
            index: 'U',
            workingTree: 'U',
            staged: true,
            unstaged: true,
            untracked: false,
            conflicted: true,
            conflictType: 'both-modified',
          },
        ],
      }),
      identity,
      sensitiveFiles: [
        {
          path: '.env',
          pattern: '.env',
          staged: true,
          untracked: false,
          ignoredByGit: true,
        },
      ],
    });

    expect(recommendations.map((item) => item.id)).toEqual(
      expect.arrayContaining(['git.advisor:conflicts', 'git.advisor:sensitive-staged']),
    );
    expect(recommendations.find((item) => item.id.endsWith('conflicts'))?.actions[0]).toMatchObject(
      {
        command: 'git.reviewConflicts',
      },
    );
  });

  it('warns about missing author identity and a branch without an initial commit', () => {
    const advisor = new GitAdvisor(new RecommendationEngine());
    const recommendations = advisor.advise({
      repositoryPath: '',
      status: status({ head: null, syncState: 'no-upstream' }),
      identity: { name: null, email: null, complete: false },
      sensitiveFiles: [],
    });

    expect(recommendations.map((item) => item.id)).toEqual(
      expect.arrayContaining(['git.advisor:identity-missing', 'git.advisor:initial-commit']),
    );
    expect(
      recommendations.find((item) => item.id === 'git.advisor:identity-missing')?.actions[0],
    ).toMatchObject({ command: 'git.configureIdentity' });
    expect(recommendations.map((item) => item.id)).not.toContain('git.advisor:no-upstream');
  });

  it('centralizes and orders notifications by severity', () => {
    const center = new NotificationCenter();
    const engine = new RecommendationEngine();
    const items = engine.evaluate('test', {}, [
      { id: 'info', evaluate: () => ({ severity: 'INFO', title: 'I', message: 'info' }) },
      { id: 'danger', evaluate: () => ({ severity: 'DANGER', title: 'D', message: 'danger' }) },
    ]);
    center.replace('workspace', 'test', items);
    expect(center.list('workspace').map((item) => item.severity)).toEqual(['DANGER', 'INFO']);
    center.clearWorkspace('workspace');
    expect(center.list('workspace')).toEqual([]);
  });

  it('requires explicit confirmation for destructive and contextual Git operations', () => {
    const policy = new GitRiskPolicy();
    expect(
      policy.assess({ operation: 'discard', branch: 'main', repository: '.', dirty: true }),
    ).toMatchObject({ level: 'DANGER', requiresConfirmation: true });
    expect(
      policy.assess({ operation: 'checkout', branch: 'main', repository: '.', dirty: true }),
    ).toMatchObject({ level: 'WARNING', requiresConfirmation: true });
    expect(
      policy.assess({ operation: 'checkout', branch: 'main', repository: '.', dirty: false }),
    ).toMatchObject({ level: 'SAFE', requiresConfirmation: false });
    expect(
      policy.assess({ operation: 'merge', branch: 'main', repository: '.', dirty: false }),
    ).toMatchObject({ level: 'WARNING', requiresConfirmation: true });
  });
});
