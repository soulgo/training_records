import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const sqlRoot = new URL('../sql/', import.meta.url);

test('sql directory keeps only environment schema directories', async () => {
  const entries = await readdir(sqlRoot, { withFileTypes: true });
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    ['dev-sql', 'main-sql'],
  );
  assert.ok(entries.every((entry) => entry.isDirectory()));
});

test('dev and main exports expose the same table and column layout without a transition SQL', async () => {
  const expectedFiles = ['archive.sql', 'core.sql', 'ingest.sql', 'monitor.sql'];
  for (const environment of ['dev', 'main']) {
    const entries = await readdir(new URL(`../sql/${environment}-sql/`, import.meta.url));
    assert.deepEqual(entries.sort(), expectedFiles);
  }

  for (const file of expectedFiles) {
    const [devSql, mainSql] = await Promise.all([
      readFile(new URL(`../sql/dev-sql/${file}`, import.meta.url), 'utf8'),
      readFile(new URL(`../sql/main-sql/${file}`, import.meta.url), 'utf8'),
    ]);
    assert.deepEqual(extractTableColumns(mainSql), extractTableColumns(devSql), file);
  }
});

function extractTableColumns(sql) {
  return Object.fromEntries(
    [...sql.matchAll(/CREATE TABLE "([^"]+)"\."([^"]+)" \(([^;]+?)\n\)\n;/gs)]
      .map((match) => [
        `${match[1]}.${match[2]}`,
        [...match[3].matchAll(/^\s*"([^"]+)"/gm)].map((column) => column[1]).sort(),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
