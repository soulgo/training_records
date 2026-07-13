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

test('dev and main exports expose the same table and column layout while dev updates stay isolated', async () => {
  const expectedFiles = ['archive.sql', 'core.sql', 'ingest.sql', 'monitor.sql'];
  const devEntries = await readdir(new URL('../sql/dev-sql/', import.meta.url), { withFileTypes: true });
  const mainEntries = await readdir(new URL('../sql/main-sql/', import.meta.url), { withFileTypes: true });
  assert.deepEqual(devEntries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort(), expectedFiles);
  assert.deepEqual(devEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), ['update-dev-sql']);
  assert.deepEqual(mainEntries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort(), expectedFiles);
  assert.deepEqual(mainEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), []);

  for (const file of expectedFiles) {
    const [devSql, mainSql] = await Promise.all([
      readFile(new URL(`../sql/dev-sql/${file}`, import.meta.url), 'utf8'),
      readFile(new URL(`../sql/main-sql/${file}`, import.meta.url), 'utf8'),
    ]);
    assert.deepEqual(extractTableColumns(mainSql), extractTableColumns(devSql), file);
  }
});

test('dev trainee profile update uses training_writer and inherits existing read grants', async () => {
  const sql = await readFile(
    new URL('../sql/dev-sql/update-dev-sql/20260713_add_core_trainee_profile.sql', import.meta.url),
    'utf8',
  );

  assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+core\.trainee_profile/iu);
  assert.match(sql, /insert\s+into\s+core\.trainee_profile/iu);
  assert.match(sql, /on\s+conflict\s*\(trainee_id\)\s+do\s+nothing/iu);
  assert.match(sql, /alter\s+table\s+core\.trainee_profile\s+owner\s+to\s+training_writer/iu);
  assert.match(sql, /from\s+information_schema\.table_privileges/iu);
  assert.match(sql, /table_schema\s*=\s*'core'/iu);
  assert.match(sql, /table_name\s*=\s*'training_day'/iu);
  assert.match(sql, /privilege_type\s*=\s*'SELECT'/u);
  assert.match(sql, /grant\s+select\s+on\s+core\.trainee_profile\s+to\s+%I/iu);
  assert.doesNotMatch(sql, /training_(?:app|maintenance|readonly)/iu);
  assert.doesNotMatch(sql, /^\s*(?:drop|truncate|delete)\b/imu);
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
