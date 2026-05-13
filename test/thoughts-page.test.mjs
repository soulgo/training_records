import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withSharedSiteFixture } from './shared-site-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

test('thoughts page lists posts from source/_posts', () => {
  withSharedSiteFixture(() => {
    execFileSync(process.execPath, ['tools/generate-training-data.mjs'], {
      cwd: rootDir,
      stdio: 'pipe',
    });
    execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
      cwd: rootDir,
      stdio: 'pipe',
    });

    const thoughtsIndex = readFileSync(path.join(rootDir, 'public', 'thoughts', 'index.html'), 'utf8');

    assert.match(thoughtsIndex, /燃脂和哑铃力量训练后屁股有点疼/);
    assert.doesNotMatch(thoughtsIndex, /还没有锻炼随想/);
  });
});
