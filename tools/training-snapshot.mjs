import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTrainingRecord } from './training-parser.mjs';
import { readTrainingSnapshotFromDatabase } from './training-db-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(__dirname, '..');
const incompleteDatabaseSnapshotPattern = /database snapshot is empty or missing measurements/i;
const unavailableDatabaseSnapshotPattern = /^database snapshot unavailable:/i;

export async function buildTrainingSnapshot(options = {}) {
  const rootDir = options.rootDir ?? defaultRootDir;
  const source = options.source ?? resolveSnapshotSource(options.env);

  if (source === 'database') {
    try {
      const snapshot = await readTrainingSnapshotFromDatabase({
        env: options.env,
        createClient: options.createClient,
        now: options.now,
      });
      if (isRenderableSnapshot(snapshot)) {
        return snapshot;
      }
      throw new Error('database snapshot is empty or missing measurements');
    } catch (error) {
      if (isIncompleteDatabaseSnapshotError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`database snapshot unavailable: ${message}`);
    }
  }

  return readTrainingSnapshotFromMarkdown(rootDir, options.now);
}

export function resolveSnapshotSource(env = process.env) {
  const configured = String(env?.TRAINING_SNAPSHOT_SOURCE ?? 'markdown').trim().toLowerCase();
  return configured === 'database' ? 'database' : 'markdown';
}

export function isIncompleteDatabaseSnapshotError(error) {
  return error instanceof Error && incompleteDatabaseSnapshotPattern.test(error.message);
}

export function isUnavailableDatabaseSnapshotError(error) {
  return error instanceof Error && unavailableDatabaseSnapshotPattern.test(error.message);
}

async function readTrainingSnapshotFromMarkdown(rootDir, now) {
  const markdown = await readFile(path.join(rootDir, '训练记录.md'), 'utf8');
  const snapshot = parseTrainingRecord(markdown);
  if (!now) {
    return snapshot;
  }
  return {
    ...snapshot,
    generatedAt: now.toISOString(),
  };
}

function isRenderableSnapshot(snapshot) {
  return (snapshot?.daily?.length ?? 0) > 0 && snapshot?.latest?.measurement;
}
