import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTrainingAnalysisContext } from '../src/adapters/postgres/training-analysis-repository.pg.mjs';

test('loadTrainingAnalysisContext uses one readonly connection and one bounded JSON query', async () => {
  const calls = [];
  const client = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params) {
      calls.push(['query', sql, params]);
      return {
        rows: [{
          context_json: {
            source: 'database',
            traineeProfile: { traineeId: 'default', profileVersion: 1 },
            daily: [],
            bodyFeedback: [],
          },
        }],
      };
    },
    async end() {
      calls.push(['end']);
    },
  };

  const context = await loadTrainingAnalysisContext({
    env: {
      TRAINING_DB_ENABLED: 'true',
      TRAINING_DB_READONLY_URL: 'postgres://readonly',
      TRAINING_DB_APP_NAME: 'analysis-read',
    },
    asOf: new Date('2026-07-12T08:00:00.000Z'),
    createClient: () => client,
  });

  assert.deepEqual(calls.map(([kind]) => kind), ['connect', 'query', 'end']);
  const [, sql, params] = calls[1];
  assert.match(sql, /core\.trainee_profile/iu);
  assert.match(sql, /is_active\s*=\s*true/iu);
  assert.match(sql, /interval '27 days'/iu);
  assert.match(sql, /thought_module\s*=\s*'body_feedback'/iu);
  assert.match(sql, /jsonb_build_object/iu);
  assert.doesNotMatch(sql, /\b(?:begin|commit|insert|update|delete)\b/iu);
  assert.deepEqual(params, ['2026-07-12T08:00:00.000Z']);
  assert.equal(context.traineeProfile.traineeId, 'default');
});

test('loadTrainingAnalysisContext rejects missing readonly database configuration', async () => {
  await assert.rejects(
    loadTrainingAnalysisContext({ env: { TRAINING_DB_ENABLED: 'true' } }),
    /readonly database URL is required/,
  );
});
