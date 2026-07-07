import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withSharedSiteFixture, writeFixtureFile } from './shared-site-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

test('withSharedSiteFixture restores generated source data files after site tests', () => {
  const trainingDataPath = path.join(rootDir, 'source', '_data', 'training.json');
  const dashboardViewPath = path.join(rootDir, 'source', '_data', 'dashboardView.json');
  const monitorViewPath = path.join(rootDir, 'source', '_data', 'monitorView.json');
  const bodyMetricsPath = path.join(rootDir, 'source', '_data', 'body-metrics.json');
  let originalTrainingData;
  let originalDashboardView;
  let originalMonitorView;
  let originalBodyMetrics;

  withSharedSiteFixture(() => {
    originalTrainingData = readOptionalFile(trainingDataPath);
    originalDashboardView = readOptionalFile(dashboardViewPath);
    originalMonitorView = readOptionalFile(monitorViewPath);
    originalBodyMetrics = readOptionalFile(bodyMetricsPath);
    writeFixtureFile(trainingDataPath, '{"dirty":true}\n');
    writeFixtureFile(dashboardViewPath, '{"dirty":true}\n');
    writeFixtureFile(monitorViewPath, '{"dirty":true}\n');
    writeFixtureFile(bodyMetricsPath, '{"dirty":true}\n');
  });

  withSharedSiteFixture(() => {
    assert.equal(readOptionalFile(trainingDataPath), originalTrainingData);
    assert.equal(readOptionalFile(dashboardViewPath), originalDashboardView);
    assert.equal(readOptionalFile(monitorViewPath), originalMonitorView);
    assert.equal(readOptionalFile(bodyMetricsPath), originalBodyMetrics);
  });
});

test('withSharedSiteFixture keeps generated source data snapshot until async site tests finish', async () => {
  const trainingDataPath = path.join(rootDir, 'source', '_data', 'training.json');
  let originalTrainingData;

  await withSharedSiteFixture(async () => {
    originalTrainingData = readOptionalFile(trainingDataPath);
    writeFixtureFile(trainingDataPath, '{"dirty":"before-await"}\n');
    await Promise.resolve();
    writeFixtureFile(trainingDataPath, '{"dirty":"after-await"}\n');
  });

  withSharedSiteFixture(() => {
    assert.equal(readOptionalFile(trainingDataPath), originalTrainingData);
  });
});

function readOptionalFile(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf8');
}
