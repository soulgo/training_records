import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const rootDir = new URL('../', import.meta.url);
const rootDirPath = fileURLToPath(rootDir);

test('eval:recognition script reports field accuracy and schema warning statistics', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', rootDir), 'utf8'));

  assert.equal(packageJson.scripts['eval:recognition'], 'node tools/eval-recognition.mjs');

  const stdout = execFileSync(process.execPath, ['tools/eval-recognition.mjs', '--json'], {
    cwd: rootDirPath,
    encoding: 'utf8',
  });
  const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));

  assert.equal(report.sampleCount >= 4, true);
  assert.deepEqual(report.imageTypes.sort(), ['measurement', 'nutrition', 'sleep', 'workout']);
  assert.equal(report.schemaFailures, 0);
  assert.equal(report.invalidSilentStore, 0);
  assert.ok(report.fieldAccuracy.overall >= 0.95);
  assert.ok(report.fieldAccuracy.byType.sleep >= 0.9);
  assert.equal(typeof report.semanticWarningCount, 'number');
});
