import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateGeneratedSiteOutput } from '../tools/run-hexo-command.mjs';

test('validateGeneratedSiteOutput rejects an empty generated homepage', async () => {
  const rootDir = await makeGeneratedSite('');

  await assert.rejects(
    () => validateGeneratedSiteOutput({ rootDir, command: 'generate' }),
    /Generated homepage is empty/,
  );
});

test('validateGeneratedSiteOutput accepts a non-empty generated homepage', async () => {
  const rootDir = await makeGeneratedSite('<!doctype html><title>ok</title>');

  await assert.doesNotReject(() => validateGeneratedSiteOutput({ rootDir, command: 'generate' }));
});

async function makeGeneratedSite(homepage) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'run-hexo-command-'));
  const publicDir = path.join(rootDir, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), homepage, 'utf8');
  return rootDir;
}
