import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { evaluateSyncBusinessResult } from '../src/app/use-cases/message-sync/status.mjs';

export async function main(argv = process.argv.slice(2), options = {}) {
  const resultPath = String(argv[0] ?? process.env.SYNC_RESULT_PATH ?? '').trim();
  const stderr = options.stderr ?? process.stderr;
  const readResultFile = options.readFile ?? readFile;
  if (!resultPath) {
    stderr.write('[sync-business-gate] result path is required\n');
    return { exitCode: 1, evaluation: null };
  }

  let result;
  try {
    result = JSON.parse(await readResultFile(resultPath, 'utf8'));
  } catch {
    stderr.write('[sync-business-gate] result file is missing or invalid\n');
    return { exitCode: 1, evaluation: null };
  }

  const evaluation = evaluateSyncBusinessResult(result);
  if (evaluation.ok) {
    return { exitCode: 0, evaluation };
  }

  const summary = evaluation.failures
    .map((failure) => [
      normalizeLogToken(failure.batchId),
      normalizeLogToken(failure.failureCategory),
      Number(failure.failedImageCount ?? 0),
    ].join(':'))
    .join(';');
  stderr.write(`[sync-business-gate] unrecovered image failures: ${summary}\n`);
  return { exitCode: 1, evaluation };
}

function normalizeLogToken(value) {
  const normalized = String(value ?? '').trim();
  return /^[a-z0-9:_.-]{1,160}$/i.test(normalized) ? normalized : 'redacted';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main();
  process.exitCode = result.exitCode;
}
