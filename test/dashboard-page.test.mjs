import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

test('dashboard renders comparison pills for the latest metrics without relying on fixed values', () => {
  execFileSync(process.execPath, ['tools/generate-training-data.mjs'], {
    cwd: rootDir,
    stdio: 'pipe',
  });
  execFileSync(process.execPath, ['tools/run-hexo-command.mjs', 'generate'], {
    cwd: rootDir,
    stdio: 'pipe',
  });

  const homepage = readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');

  assert.match(homepage, /较前一日(?:下降|新增) [\d.]+%/);
  assert.match(homepage, /comparison-pill comparison-pill--down/);
  assert.match(homepage, /comparison-pill comparison-pill--up/);
  assert.match(homepage, /comparison-pill__arrow">↓<\/span><span>较前一日(?:下降|新增) [\d.]+%/);
  assert.match(homepage, /comparison-pill__arrow">↑<\/span><span>较前一日(?:下降|新增) [\d.]+%/);
});
