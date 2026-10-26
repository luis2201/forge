import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPathInside, canonicalizeDirectory } from '../../src/main/core/workspaces';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('workspace path authorization', () => {
  it('accepts a real descendant and the root itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-root-'));
    created.push(root);
    const child = join(root, 'src');
    await mkdir(child);
    await expect(assertPathInside(root, child)).resolves.toBeTruthy();
    await expect(assertPathInside(root, root)).resolves.toBeTruthy();
  });

  it('rejects a sibling with a deceptive common prefix', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'forge-parent-'));
    created.push(parent);
    const root = join(parent, 'project');
    const sibling = join(parent, 'project-secret');
    await mkdir(root);
    await mkdir(sibling);
    await expect(assertPathInside(root, sibling)).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
  });

  it('rejects missing directories with an actionable error', async () => {
    await expect(
      canonicalizeDirectory(join(tmpdir(), 'forge-does-not-exist')),
    ).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' });
  });
});
