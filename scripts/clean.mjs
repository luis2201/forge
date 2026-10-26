import { rm } from 'node:fs/promises';

await Promise.all(['dist', 'release'].map((path) => rm(path, { recursive: true, force: true })));
