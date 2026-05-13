import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTrainingRecord } from './training-parser.mjs';
import { readTrainingSnapshotFromDatabase } from './training-db-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(__dirname, '..');

export async function buildTrainingSnapshot(options = {}) {
  const rootDir = options.rootDir ?? defaultRootDir;
  const source = options.source ?? resolveSnapshotSource(options.env);

  if (source === 'database') {
    return readTrainingSnapshotFromDatabase({
      env: options.env,
      createClient: options.createClient,
      now: options.now,
    });
  }

  const markdown = await readFile(path.join(rootDir, '训练记录.md'), 'utf8');
  const snapshot = parseTrainingRecord(markdown);
  if (options.now) {
    return {
      ...snapshot,
      generatedAt: options.now.toISOString(),
    };
  }
  return snapshot;
}

export function resolveSnapshotSource(env = process.env) {
  const configured = String(env?.TRAINING_SNAPSHOT_SOURCE ?? 'markdown').trim().toLowerCase();
  return configured === 'database' ? 'database' : 'markdown';
}
