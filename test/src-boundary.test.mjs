import test from 'node:test';
import assert from 'node:assert/strict';

import * as domainTraining from '../src/domain/training/index.mjs';
import * as telegram from '../src/telegram/index.mjs';
import * as site from '../src/site/index.mjs';
import * as db from '../src/db/index.mjs';
import * as jobs from '../src/jobs/index.mjs';

test('src boundary entry points exist and re-export expected modules', () => {
  assert.ok(domainTraining.parseTrainingRecord);
  assert.ok(domainTraining.buildTrainingSnapshot);
  assert.ok(telegram.createTelegramCommandResolver);
  assert.ok(telegram.isTelegramHelpText);
  assert.ok(site.buildDashboardViewModel);
  assert.ok(db.readTrainingSnapshotFromDatabase);
  assert.ok(db.persistNormalizedBatch);
  assert.ok(jobs.runTelegramSyncJob);
  assert.ok(jobs.runGenerateTrainingDataJob);
  assert.ok(jobs.runTrainingAnalysisJob);
  assert.ok(jobs.createFilePendingStore);
  assert.ok(jobs.createJobExecutionContext);
  assert.ok(jobs.normalizeJobResult);
});
