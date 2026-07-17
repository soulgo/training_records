import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateRecognitionCompleteness } from '../src/core/ai/recognition-completeness.mjs';
import { reconcileRecognitionResults } from '../src/core/ai/recognition-reconciliation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultFixtureDir = path.join(rootDir, 'test', 'fixtures', 'recognition-eval');
const BLOCKING_RECONCILIATION_STATUSES = ['conflict', 'incomplete', 'fallback_unavailable'];

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

  const contracts = await evaluateContractFixtures({
    contractsDir: path.join(fixtureDir, 'contracts'),
  });

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
    completenessContract: contracts,
    accuracy: { status: 'not_measured', reason: 'no_natural_samples' },
    tokens: { status: 'not_measured', reason: 'no_provider_run' },
    latency: { status: 'not_measured', reason: 'no_provider_run' },
  };
}

async function evaluateContractFixtures({ contractsDir }) {
  const files = await readContractFiles(contractsDir);
  const byStatus = { complete: 0, incomplete: 0, needs_review: 0 };
  const failures = [];
  let stored = 0;
  let blockedIncomplete = 0;
  let blockedConflict = 0;
  let fallbackCompleted = 0;
  let silentStore = 0;

  for (const file of files) {
    const sample = JSON.parse(await readFile(file, 'utf8'));
    const outcome = evaluateContractSample(sample);
    byStatus[outcome.finalStatus] = (byStatus[outcome.finalStatus] ?? 0) + 1;
    if (outcome.stored) stored += 1;
    if (!outcome.stored && outcome.reconciliationStatus === 'conflict') blockedConflict += 1;
    else if (!outcome.stored) blockedIncomplete += 1;
    if (outcome.reconciliationStatus === 'fallback_completed') fallbackCompleted += 1;
    // silent store: 合同期望不入库，但计算结果却会被写入 core —— 必须为 0。
    if (sample.expected?.stored === false && outcome.stored) silentStore += 1;
    for (const failure of outcome.failures) {
      failures.push(`${sample.sampleId}: ${failure}`);
    }
  }

  return {
    total: files.length,
    stored,
    blockedIncomplete,
    blockedConflict,
    fallbackCompleted,
    silentStore,
    byStatus,
    failures,
  };
}

function evaluateContractSample(sample) {
  const ocrDocument = sample.ocr ?? null;
  const primaryCompleteness = evaluateRecognitionCompleteness({
    recognition: sample.recognition,
    ocrDocument,
  });

  let reconciliation = null;
  let finalCompleteness = primaryCompleteness;
  if (sample.fallback) {
    reconciliation = reconcileRecognitionResults({
      primary: sample.recognition,
      fallback: sample.fallback,
    });
    finalCompleteness = reconciliation.value
      ? evaluateRecognitionCompleteness({ recognition: reconciliation.value, ocrDocument })
      : primaryCompleteness;
  }

  const reconciliationStatus = reconciliation?.status ?? null;
  const stored = finalCompleteness.status === 'complete'
    && !(reconciliationStatus && BLOCKING_RECONCILIATION_STATUSES.includes(reconciliationStatus));

  const failures = [];
  const expected = sample.expected ?? {};
  if (expected.stored !== undefined && expected.stored !== stored) {
    failures.push(`expected stored=${expected.stored} but got ${stored}`);
  }
  if (expected.completeness) {
    checkStatus(failures, 'completeness.status', expected.completeness.status, finalCompleteness.status);
    if (expected.completeness.requiresFallback !== undefined) {
      checkStatus(
        failures,
        'completeness.requiresFallback',
        expected.completeness.requiresFallback,
        primaryCompleteness.requiresFallback,
      );
    }
    checkSubset(failures, 'completeness.missingFields', expected.completeness.missingFields, primaryCompleteness.missingFields);
    checkSubset(failures, 'completeness.conditionalFields', expected.completeness.conditionalFields, primaryCompleteness.conditionalFields);
  }
  if (expected.reconciliation) {
    checkStatus(failures, 'reconciliation.status', expected.reconciliation.status, reconciliationStatus);
    checkSubset(failures, 'reconciliation.filledFields', expected.reconciliation.filledFields, reconciliation?.filledFields);
    checkSubset(failures, 'reconciliation.conflictFields', expected.reconciliation.conflictFields, reconciliation?.conflictFields);
  }

  return {
    finalStatus: finalCompleteness.status,
    reconciliationStatus,
    stored,
    failures,
  };
}

function checkStatus(failures, label, expected, actual) {
  if (expected !== undefined && expected !== actual) {
    failures.push(`expected ${label}=${expected} but got ${actual}`);
  }
}

function checkSubset(failures, label, expectedList, actualList) {
  if (!Array.isArray(expectedList)) return;
  const actual = new Set(Array.isArray(actualList) ? actualList : []);
  const missing = expectedList.filter((item) => !actual.has(item));
  if (missing.length > 0) {
    failures.push(`${label} missing ${missing.join(', ')}`);
  }
}

async function readContractFiles(contractsDir) {
  try {
    const entry = await stat(contractsDir);
    if (!entry.isDirectory()) return [];
  } catch {
    return [];
  }
  return (await readdir(contractsDir))
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => path.join(contractsDir, file));
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
  const contracts = report.completenessContract;
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(
      `recognition fixture contract: ${report.sampleCount} samples, field match ${report.fixtureContract.fieldMatchRate.overall}; accuracy ${report.accuracy.status}\n`,
    );
    process.stdout.write(
      `completeness contract: ${contracts.total} scenarios, stored ${contracts.stored}, blocked-incomplete ${contracts.blockedIncomplete}, blocked-conflict ${contracts.blockedConflict}, fallback-completed ${contracts.fallbackCompleted}, silent-store ${contracts.silentStore}\n`,
    );
  }
  if (contracts.failures.length > 0 || contracts.silentStore > 0) {
    for (const failure of contracts.failures) {
      process.stderr.write(`contract mismatch: ${failure}\n`);
    }
    if (contracts.silentStore > 0) {
      process.stderr.write(`contract mismatch: ${contracts.silentStore} scenario(s) would silently store incomplete data\n`);
    }
    process.exitCode = 1;
  }
}
