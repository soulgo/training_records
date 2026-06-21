import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importTrainingMarkdownToDatabase } from './training-db-core.mjs';
import { parseTrainingRecord } from '../src/domain/training/training-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export async function reconcileTrainingMarkdownToCore(options = {}) {
  const activeRootDir = options.rootDir ?? rootDir;
  const markdownPath = options.markdownPath ?? path.join(activeRootDir, '训练记录.md');
  const stderr = options.stderr ?? process.stderr;
  const importMarkdown =
    options.importTrainingMarkdownToDatabase ?? importTrainingMarkdownToDatabase;
  const markdown = await readFile(markdownPath, 'utf8');

  if (options.dryRun) {
    const affectedDays = getAffectedMarkdownDays(markdown);
    return {
      status: 'planned',
      dryRun: true,
      readonly: true,
      affectedDays,
      days: affectedDays.length,
    };
  }

  try {
    return await importMarkdown({
      markdown,
      env: options.env ?? process.env,
      createClient: options.createClient,
      processedAt: options.processedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[reconcile-training-markdown-to-core] ${message}\n`);
    return {
      status: 'deferred',
      error: message,
    };
  }
}

function getAffectedMarkdownDays(markdown) {
  const snapshot = parseTrainingRecord(markdown);
  return [
    ...new Set(
      (snapshot.daily ?? [])
        .map((day) => normalizeDateKey(day?.date))
        .filter(isValidDateKey),
    ),
  ].sort();
}

function normalizeDateKey(value) {
  if (value instanceof Date) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  }
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : String(value ?? '');
}

function isValidDateKey(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return false;
  }
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await reconcileTrainingMarkdownToCore();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
