import { checkTrainingDataConsistency } from '../src/db/training/consistency-check.mjs';

const result = await checkTrainingDataConsistency();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status === 'failed') {
  process.exitCode = 1;
}
