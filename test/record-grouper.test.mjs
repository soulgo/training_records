import assert from 'node:assert/strict';
import test from 'node:test';

import { groupAcceptedRecordsByDate } from '../src/domain/training/record-grouper.mjs';

test('RecordGrouper splits a multi-date batch without cross-date contamination', () => {
  const groups = groupAcceptedRecordsByDate([
    { recordType: 'activity', archivedDate: '2026-07-10', status: 'accepted', fields: { activityType: 'run' } },
    { recordType: 'meal', archivedDate: '2026-07-11', status: 'accepted', fields: { name: 'dinner' } },
    { recordType: 'sleep', archivedDate: null, status: 'needs_review', fields: {} },
  ]);

  assert.deepEqual(groups, [
    {
      archivedDate: '2026-07-10',
      records: [{ recordType: 'activity', archivedDate: '2026-07-10', status: 'accepted', fields: { activityType: 'run' } }],
    },
    {
      archivedDate: '2026-07-11',
      records: [{ recordType: 'meal', archivedDate: '2026-07-11', status: 'accepted', fields: { name: 'dinner' } }],
    },
  ]);
});
