import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { applyTelegramSyncToMarkdown } from '../../../adapters/telegram/sync-batch.adapter.mjs';
import { isTrainingDataBatchKind } from './status.mjs';

const MAX_PENDING_QUEUE_SIZE = 1000;

export async function readMarkdownOrDefault(recordPath) {
  try {
    return await readFile(recordPath, 'utf8');
  } catch {
    return '';
  }
}

export async function appendPendingFallbackBatch(queuePath, payload) {
  const existing = await readPendingFallbackBatchesRaw(queuePath);
  const deduped = existing.filter((entry) => entry.batch?.batchId !== payload.batch?.batchId);
  const trimmed = deduped.length >= MAX_PENDING_QUEUE_SIZE
    ? deduped.slice(-MAX_PENDING_QUEUE_SIZE + 1)
    : deduped;
  trimmed.push(payload);
  await mkdir(path.dirname(queuePath), { recursive: true });
  const content = trimmed.map((entry) => JSON.stringify(entry)).join('\n');
  await writeFile(queuePath, content ? `${content}\n` : '', 'utf8');
}

export async function writePendingFallbackBatches(queuePath, entries, options = {}) {
  await mkdir(path.dirname(queuePath), { recursive: true });
  if (options.backupBeforeWrite) {
    await backupPendingFallbackQueue(queuePath, options.now);
  }
  const trimmed = entries.length > MAX_PENDING_QUEUE_SIZE
    ? entries.slice(-MAX_PENDING_QUEUE_SIZE)
    : entries;
  const content = trimmed.map((entry) => JSON.stringify(entry)).join('\n');
  await writeFile(queuePath, content ? `${content}\n` : '', 'utf8');
}

export async function readPendingFallbackBatches(queuePath) {
  return readPendingFallbackBatchesRaw(queuePath);
}

async function readPendingFallbackBatchesRaw(queuePath) {
  try {
    const raw = await readFile(queuePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function backupPendingFallbackQueue(queuePath, now = new Date()) {
  const suffix = now.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.', '');
  await copyFile(queuePath, `${queuePath}.backup-${suffix}`);
}

export function rebuildMarkdownFromPersistedBatches(markdown, batches) {
  return batches.reduce((currentMarkdown, batch) => {
    const applied = applyTelegramSyncToMarkdown(currentMarkdown, batch);
    return applied.markdown;
  }, markdown);
}

export function shouldRewriteTrainingMarkdown({ replayStoredImageAny, batchResults }) {
  if (replayStoredImageAny) {
    return true;
  }

  return (batchResults ?? []).some(
    (batch) =>
      isTrainingDataBatchKind(batch.kind) &&
      batch.status === 'ready' &&
      batch.persistenceStatus === 'stored',
  );
}
