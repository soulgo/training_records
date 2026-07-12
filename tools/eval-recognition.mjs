import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultFixtureDir = path.join(rootDir, 'test', 'fixtures', 'recognition-eval');

export async function evaluateRecognitionFixtures({
  fixtureDir = defaultFixtureDir,
} = {}) {
  const fixtureFiles = (await readdir(fixtureDir))
    .filter((file) => file.endsWith('.json'))
    .sort();
  const samples = await Promise.all(
    fixtureFiles.map(async (file) =>
      JSON.parse(await readFile(path.join(fixtureDir, file), 'utf8'))
    ),
  );
  const typeStats = new Map();
  let passedFields = 0;
  let totalFields = 0;
  let schemaFailures = 0;
  let semanticWarningCount = 0;

  for (const sample of samples) {
    const type = sample.imageType;
    if (!typeStats.has(type)) {
      typeStats.set(type, { passed: 0, total: 0 });
    }
    if (sample.schemaValid === false) {
      schemaFailures += 1;
    }
    semanticWarningCount += Array.isArray(sample.actual?.warnings) ? sample.actual.warnings.length : 0;
    for (const assertion of sample.fields ?? []) {
      const expected = readPath(sample.expected, assertion.path);
      const actual = readPath(sample.actual, assertion.path);
      const passed = valuesMatch(expected, actual, assertion.tolerance ?? 0);
      totalFields += 1;
      typeStats.get(type).total += 1;
      if (passed) {
        passedFields += 1;
        typeStats.get(type).passed += 1;
      }
    }
  }

  return {
    sampleCount: samples.length,
    imageTypes: [...new Set(samples.map((sample) => sample.imageType))].sort(),
    schemaFailures,
    invalidSilentStore: schemaFailures,
    semanticWarningCount,
    fixtureContract: {
      fieldMatchRate: {
        overall: ratio(passedFields, totalFields),
        byType: Object.fromEntries(
          [...typeStats.entries()].map(([type, stats]) => [type, ratio(stats.passed, stats.total)]),
        ),
      },
    },
    accuracy: { status: 'not_measured', reason: 'no_natural_samples' },
    tokens: { status: 'not_measured', reason: 'no_provider_run' },
    latency: { status: 'not_measured', reason: 'no_provider_run' },
  };
}

function readPath(value, pathExpression) {
  return String(pathExpression ?? '')
    .split('.')
    .filter(Boolean)
    .reduce((current, segment) => current?.[segment], value);
}

function valuesMatch(expected, actual, tolerance) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(expected - actual) <= tolerance;
  }
  return Object.is(expected, actual);
}

function ratio(passed, total) {
  return total > 0 ? Number((passed / total).toFixed(4)) : 1;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  const report = await evaluateRecognitionFixtures();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(
      `recognition fixture contract: ${report.sampleCount} samples, field match ${report.fixtureContract.fieldMatchRate.overall}; accuracy ${report.accuracy.status}\n`,
    );
  }
}
