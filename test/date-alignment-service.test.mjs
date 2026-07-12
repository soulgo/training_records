import assert from 'node:assert/strict';
import test from 'node:test';

import { alignObservationDates } from '../src/domain/training/date-alignment-service.mjs';

const observation = (overrides = {}) => ({
  recordType: 'activity',
  observedDate: null,
  observedTime: null,
  dateEvidence: { source: 'none', rawText: null, yearVisible: false },
  confidence: 0.9,
  fields: {},
  ...overrides,
});

test('DateAlignmentService resolves exact, derived, filename, and unresolved observations independently', () => {
  const aligned = alignObservationDates({
    messageSentAt: '2026-01-02T08:00:00.000Z',
    filename: 'health-2025-12-31.png',
    observations: [
      observation({
        observedDate: '2026-01-01',
        dateEvidence: { source: 'visible_full_date', rawText: '2026-01-01', yearVisible: true },
      }),
      observation({
        dateEvidence: { source: 'visible_month_day', rawText: '12-31', yearVisible: false },
      }),
      observation({
        recordType: 'sleep',
        observedDate: '2026-01-02',
        dateEvidence: { source: 'visible_full_date', rawText: 'wake 2026-01-02', yearVisible: true },
        fields: { bedtime: null, wakeTime: '2026-01-02 07:00' },
      }),
      observation({
        dateEvidence: { source: 'visible_filename', rawText: null, yearVisible: false },
      }),
      observation(),
    ],
  });

  assert.deepEqual(
    aligned.map(({ archivedDate, dateResolution, status }) => [archivedDate, dateResolution, status]),
    [
      ['2026-01-01', 'exact_image', 'accepted'],
      ['2025-12-31', 'derived_message_year', 'accepted'],
      ['2026-01-01', 'derived_sleep_start', 'accepted'],
      ['2025-12-31', 'filename_fallback', 'accepted'],
      [null, 'unresolved', 'needs_review'],
    ],
  );
});

test('DateAlignmentService keeps invalid month-day evidence unresolved', () => {
  const [aligned] = alignObservationDates({
    messageSentAt: '2026-12-31T08:00:00.000Z',
    observations: [observation({
      dateEvidence: { source: 'visible_month_day', rawText: '02-30', yearVisible: false },
    })],
  });

  assert.equal(aligned.archivedDate, null);
  assert.equal(aligned.dateResolution, 'unresolved');
  assert.equal(aligned.status, 'needs_review');
});

test('DateAlignmentService propagates one compatible anchor within ten minutes', () => {
  const aligned = alignObservationDates({
    messageSentAt: '2026-07-12T08:00:00.000Z',
    observations: [
      observation({
        observedDate: '2026-07-11',
        sourceApp: 'Unknown Health',
        sourceMessageSentAt: '2026-07-12T08:00:00.000Z',
        dateEvidence: { source: 'visible_full_date', rawText: '2026-07-11', yearVisible: true },
      }),
      observation({
        sourceApp: 'Unknown Health',
        sourceMessageSentAt: '2026-07-12T08:08:00.000Z',
      }),
    ],
  });

  assert.equal(aligned[1].archivedDate, '2026-07-11');
  assert.equal(aligned[1].dateResolution, 'derived_batch_anchor');
  assert.equal(aligned[1].status, 'accepted');
});

test('DateAlignmentService keeps undated observations isolated when a batch has multiple explicit dates', () => {
  const aligned = alignObservationDates({
    messageSentAt: '2026-07-12T08:00:00.000Z',
    observations: [
      observation({ observedDate: '2026-07-10', dateEvidence: { source: 'visible_full_date', rawText: '2026-07-10', yearVisible: true } }),
      observation({ observedDate: '2026-07-11', dateEvidence: { source: 'visible_full_date', rawText: '2026-07-11', yearVisible: true } }),
      observation(),
    ],
  });

  assert.deepEqual(aligned.map((item) => item.archivedDate), ['2026-07-10', '2026-07-11', null]);
  assert.equal(aligned[2].status, 'needs_review');
});
