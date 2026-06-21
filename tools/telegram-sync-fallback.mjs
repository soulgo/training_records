import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendPendingFallbackBatch,
  readMarkdownOrDefault,
  readPendingFallbackBatches,
  writePendingFallbackBatches,
} from '../src/app/use-cases/telegram-sync/fallback.mjs';

export {
  appendPendingFallbackBatch,
  readMarkdownOrDefault,
  readPendingFallbackBatches,
  writePendingFallbackBatches,
};

const modulePath = fileURLToPath(import.meta.url);
const __dirname = path.dirname(modulePath);
const rootDir = path.resolve(__dirname, '..');
const DEFAULT_QUEUE_PATH = path.join(rootDir, 'runtime', 'telegram-sync-pending.ndjson');

export async function inspectPendingFallbackQueue({ queuePath = DEFAULT_QUEUE_PATH } = {}) {
  const entries = await readPendingFallbackBatches(queuePath);

  return {
    status: 'ok',
    queuePath,
    totalEntries: entries.length,
    entries: entries.map((entry) => ({
      batchId: entry.batch?.batchId ?? null,
      kind: entry.batch?.kind ?? null,
      archivedDate: entry.batch?.archivedDate ?? null,
      status: entry.batch?.status ?? null,
      failedAt: entry.failedAt ?? null,
      error: entry.error ?? null,
    })),
  };
}

export function formatPendingFallbackInspection(inspection) {
  const lines = [
    'Legacy NDJSON pending inspection (read-only)',
    `queuePath: ${inspection.queuePath}`,
    `totalEntries: ${inspection.totalEntries}`,
  ];

  for (const entry of inspection.entries) {
    lines.push(
      [
        `- batchId=${entry.batchId ?? 'unknown'}`,
        `kind=${entry.kind ?? 'unknown'}`,
        `archivedDate=${entry.archivedDate ?? 'unknown'}`,
        `status=${entry.status ?? 'unknown'}`,
        `failedAt=${entry.failedAt ?? 'unknown'}`,
        `error=${entry.error ?? ''}`,
      ].join(' '),
    );
  }

  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const [command, queuePathArg] = argv;
  if (command && command !== 'inspect') {
    throw new Error(`Unsupported telegram-sync-fallback command: ${command}`);
  }

  const inspection = await inspectPendingFallbackQueue({
    queuePath: queuePathArg ? path.resolve(queuePathArg) : DEFAULT_QUEUE_PATH,
  });
  process.stdout.write(formatPendingFallbackInspection(inspection));
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
