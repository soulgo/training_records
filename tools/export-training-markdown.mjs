import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportTrainingMarkdown, resolveTrainingCoreConfig } from './training-db-core.mjs';
import {
  buildTrainingSnapshot,
  isIncompleteDatabaseSnapshotError,
  isUnavailableDatabaseSnapshotError,
} from './training-snapshot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export async function exportDerivedTrainingMarkdown(options = {}) {
  const activeRootDir = options.rootDir ?? rootDir;
  const outputPath = options.outputPath ?? path.join(activeRootDir, '训练记录.md');
  const stderr = options.stderr ?? process.stderr;
  const snapshotSource =
    options.source ??
    ((await hasPendingTelegramFallbackBatches(activeRootDir)) ? 'markdown' : 'database');
  const buildSnapshot = options.buildTrainingSnapshot ?? buildTrainingSnapshot;
  const trainingDbConfig = resolveTrainingCoreConfig(options.env ?? process.env);
  const canFallbackFromDatabase =
    snapshotSource === 'database' && trainingDbConfig.enabled && Boolean(trainingDbConfig.url);
  const snapshotOptions = {
    source: snapshotSource,
    rootDir: activeRootDir,
    env: options.env ?? process.env,
    createClient: options.createClient,
    now: options.now,
  };
  let snapshot;

  try {
    snapshot = await buildSnapshot(snapshotOptions);
  } catch (error) {
    if (canFallbackFromDatabase && canUseMarkdownFallback(error)) {
      stderr.write(
        `[export-training-markdown] ${error.message}; falling back to markdown\n`,
      );
      snapshot = await buildSnapshot({
        ...snapshotOptions,
        source: 'markdown',
      });
    } else {
      throw error;
    }
  }

  const markdown = (options.exportTrainingMarkdown ?? exportTrainingMarkdown)(snapshot);
  await writeFile(outputPath, markdown, 'utf8');
  return {
    outputPath,
    snapshot,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await exportDerivedTrainingMarkdown();
}

async function hasPendingTelegramFallbackBatches(rootDir) {
  try {
    const queuePath = path.join(rootDir, 'runtime', 'telegram-sync-pending.ndjson');
    const raw = await readFile(queuePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .some((line) => line.trim().length > 0);
  } catch {
    return false;
  }
}

function canUseMarkdownFallback(error) {
  return isIncompleteDatabaseSnapshotError(error) || isUnavailableDatabaseSnapshotError(error);
}
