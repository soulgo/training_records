import path from 'node:path';
import {
  getThoughtModuleTags,
  normalizeThoughtModule,
  normalizeThoughtModuleOrNull,
} from '../../core/thought-modules.mjs';
import { fetchTelegramFile } from '../../adapters/telegram/index.mjs';
import { buildPersistenceSummary } from './message-sync/persistence-summary.mjs';
import { classifyFailureCategory } from './message-sync/status.mjs';
import { writeThoughtImageArtifacts } from './message-sync/thought-artifacts.mjs';
import { withPendingStatus } from './message-sync-timings.mjs';

const MAX_THOUGHT_MARKDOWN_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function attachThoughtStorageMetadata(batch, writeResult, activeRootDir) {
  const storage = {
    markdownPath: toRepoRelativePath(writeResult.postPath, activeRootDir),
    photoPaths: writeResult.photoPaths === undefined ? [] : writeResult.photoPaths,
    deletedPhotoPaths: (writeResult.deletedPhotoPaths ?? [])
      .map((photoPath) => toPublicThoughtImagePath(photoPath, activeRootDir))
      .filter(Boolean),
    writeStatus: writeResult.status ?? null,
    imageUploadStats: writeResult.storageStats ?? null,
  };

  if (batch.kind === 'thought') {
    const nextModule = normalizeThoughtModule(writeResult.thoughtModule ?? batch.thought?.thoughtModule);
    return {
      ...batch,
      thought: {
        ...batch.thought,
        thoughtModule: nextModule,
        tags: writeResult.tags ?? batch.thought?.tags ?? getThoughtModuleTags(nextModule),
        storage,
      },
    };
  }

  if (batch.kind === 'thought_edit') {
    const nextModule = normalizeThoughtModuleOrNull(writeResult.thoughtModule ?? batch.thoughtEdit?.thoughtModule);
    return {
      ...batch,
      thoughtEdit: {
        ...batch.thoughtEdit,
        thoughtModule: nextModule,
        tags: writeResult.tags ?? batch.thoughtEdit?.tags,
        storage,
      },
    };
  }

  if (batch.kind === 'thought_delete') {
    const nextModule = normalizeThoughtModuleOrNull(writeResult.thoughtModule ?? batch.thoughtDelete?.thoughtModule);
    return {
      ...batch,
      thoughtDelete: {
        ...batch.thoughtDelete,
        thoughtModule: nextModule,
        tags: writeResult.tags ?? batch.thoughtDelete?.tags,
        storage,
      },
    };
  }

  if (batch.kind === 'thought_move') {
    const nextModule = normalizeThoughtModuleOrNull(writeResult.thoughtModule ?? batch.thoughtMove?.thoughtModule);
    return {
      ...batch,
      thoughtMove: {
        ...batch.thoughtMove,
        thoughtModule: nextModule,
        tags: writeResult.tags ?? batch.thoughtMove?.tags,
        storage,
      },
    };
  }

  return batch;
}

function toRepoRelativePath(targetPath, activeRootDir) {
  if (!targetPath || !activeRootDir) {
    return null;
  }

  const relative = path.relative(activeRootDir, targetPath).split(path.sep).join('/');
  return relative && !relative.startsWith('..') ? relative : targetPath;
}

function toPublicThoughtImagePath(targetPath, activeRootDir) {
  if (!targetPath || !activeRootDir) {
    return null;
  }

  const relative = toRepoRelativePath(targetPath, activeRootDir);
  if (typeof relative !== 'string') {
    return null;
  }
  return relative.startsWith('source/images/')
    ? `/${relative.slice('source/'.length)}`
    : relative;
}

export async function handleThoughtSyncBatch({
  batch,
  kind,
  thoughtsDir,
  activeRootDir,
  now,
  env,
  persistBatch,
  appendPendingPersistenceBatch,
  fetchTelegramFile,
  imageStorage,
}) {
  const preparedThoughtBatch = await prepareThoughtMarkdownBody({
    batch,
    kind,
    fetchTelegramFile,
  });
  if (preparedThoughtBatch.status === 'failed') {
    return {
      changed: false,
      batchResult: {
        ...batch,
        status: 'skipped',
        reason: preparedThoughtBatch.reason,
        failureCategory: preparedThoughtBatch.failureCategory,
        failureReason: preparedThoughtBatch.reason,
        postPath: null,
        thoughtWriteStatus: 'failed',
        persistenceStatus: null,
      },
    };
  }
  const batchWithMarkdownBody = preparedThoughtBatch.batch;
  const thoughtWriteResult = await writeThoughtArtifact({
    batch: batchWithMarkdownBody,
    kind,
    thoughtsDir,
    activeRootDir,
    fetchTelegramFile,
    env,
    imageStorage,
  });
  const thoughtStorageBatch = attachThoughtStorageMetadata(
    batchWithMarkdownBody,
    thoughtWriteResult,
    activeRootDir,
  );
  const baseBatchResult = {
    ...thoughtStorageBatch,
    postPath: thoughtWriteResult.postPath,
    thoughtWriteStatus: thoughtWriteResult.status,
  };
  if (Array.isArray(thoughtWriteResult.deletedPhotoPaths)) {
    baseBatchResult.deletedPhotoPaths = thoughtWriteResult.deletedPhotoPaths;
  }

  try {
    const persistResult = await persistBatch({
      batch: thoughtStorageBatch,
      processedAt: now,
      env,
    });
    const persistenceResult = buildPersistenceSummary(persistResult);
    if (persistResult.status === 'not_found') {
      const targetMessageId = persistResult.messageId ?? getThoughtTargetMessageId(thoughtStorageBatch);
      const reason = `target thought ${targetMessageId ?? 'unknown'} not found`;
      return {
        changed: false,
        batchResult: {
          ...baseBatchResult,
          status: 'skipped',
          reason,
          thoughtWriteStatus: 'not_found',
          persistenceStatus: 'not_found',
          failureCategory: 'user_input',
          failureReason: reason,
          ...(persistenceResult ? { persistenceResult } : {}),
        },
      };
    }
    return {
      changed: thoughtWriteResult.changed || persistResult.status === 'stored',
      batchResult: {
        ...baseBatchResult,
        persistenceStatus: persistResult.status,
        ...(persistenceResult ? { persistenceResult } : {}),
        persistedThoughtModule: persistResult.thoughtModule ?? null,
        persistedThoughtMessageId:
          persistResult.messageId ?? getPersistedThoughtMessageId(thoughtStorageBatch),
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await appendPendingPersistenceBatch({
      batch: thoughtStorageBatch,
      failureCategory: 'database',
      error: errorMessage,
      failedAt: now.toISOString(),
    });
    const persistenceResult = withPendingStatus(buildPersistenceSummary(error.persistenceResult), 'queued');
    return {
      changed: thoughtWriteResult.changed,
      batchResult: {
        ...baseBatchResult,
        persistenceStatus: 'pending_replay',
        persistenceError: errorMessage,
        failureCategory: classifyFailureCategory(errorMessage, { phase: 'database' }),
        failureReason: errorMessage,
        ...(persistenceResult ? { persistenceResult } : {}),
      },
    };
  }
}

function getThoughtTargetMessageId(batch) {
  return (
    batch.thoughtEdit?.targetMessageId ??
    batch.thoughtDelete?.targetMessageId ??
    batch.thoughtMove?.targetMessageId ??
    null
  );
}

function getPersistedThoughtMessageId(batch) {
  return batch.thought?.telegramMessageId ?? getThoughtTargetMessageId(batch);
}

async function prepareThoughtMarkdownBody({ batch, kind, fetchTelegramFile }) {
  if (kind !== 'thought' && kind !== 'thought_edit') {
    return { status: 'ready', batch };
  }

  const markdownDocument = findThoughtMarkdownDocument(batch);
  if (!markdownDocument) {
    return { status: 'ready', batch };
  }

  if (!fetchTelegramFile) {
    return {
      status: 'failed',
      reason: 'Telegram markdown attachment download is not configured',
      failureCategory: 'telegram_api',
    };
  }

  if (
    Number.isFinite(markdownDocument.fileSize) &&
    markdownDocument.fileSize > MAX_THOUGHT_MARKDOWN_ATTACHMENT_BYTES
  ) {
    return {
      status: 'failed',
      reason: `markdown attachment too large: ${markdownDocument.fileSize} bytes`,
      failureCategory: 'user_input',
    };
  }

  try {
    const file = await fetchTelegramFile(markdownDocument.fileId);
    const data = file?.data;
    if (!(data instanceof Uint8Array)) {
      return {
        status: 'failed',
        reason: 'markdown attachment download returned no file data',
        failureCategory: 'telegram_api',
      };
    }
    if (data.byteLength > MAX_THOUGHT_MARKDOWN_ATTACHMENT_BYTES) {
      return {
        status: 'failed',
        reason: `markdown attachment too large: ${data.byteLength} bytes`,
        failureCategory: 'user_input',
      };
    }

    const body = new TextDecoder('utf-8').decode(data).replace(/^\uFEFF/u, '').trim();
    if (!body) {
      return {
        status: 'failed',
        reason: 'empty markdown attachment',
        failureCategory: 'user_input',
      };
    }

    return {
      status: 'ready',
      batch: attachMarkdownBodyToThoughtBatch(batch, kind, body),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      reason: errorMessage,
      failureCategory: classifyFailureCategory(errorMessage, { phase: 'telegram_file_download' }),
    };
  }
}

function attachMarkdownBodyToThoughtBatch(batch, kind, body) {
  if (kind === 'thought_edit') {
    return {
      ...batch,
      thoughtEdit: {
        ...batch.thoughtEdit,
        body,
      },
    };
  }

  return {
    ...batch,
    thought: {
      ...batch.thought,
      body,
    },
  };
}

function findThoughtMarkdownDocument(batch) {
  const sourceMessageId = batch.thought?.sourceMessageId ?? null;
  const messages = [...(batch.messages ?? [])].sort((left, right) => left.messageId - right.messageId);
  const sourceMessage = messages.find((message) => message.messageId === sourceMessageId);
  return (
    sourceMessage?.markdownDocuments?.[0] ??
    messages.find((message) => (message.markdownDocuments?.length ?? 0) > 0)?.markdownDocuments?.[0] ??
    null
  );
}

async function writeThoughtArtifact({
  batch,
  kind,
  thoughtsDir,
  activeRootDir,
  fetchTelegramFile,
  imageStorage,
}) {
  if (kind === 'thought') {
    const result = await writeThoughtImageArtifacts({
      batch,
      rootDir: activeRootDir,
      fetchTelegramFile,
      imageStorage,
    });
    if (result.status === 'no_images') {
      return {
        ...result,
        status: 'thought_database_only',
      };
    }
    return result;
  }

  if (kind === 'thought_edit') {
    if (batch.thoughtEdit?.replacePhotos) {
      return writeThoughtImageArtifacts({
        batch,
        rootDir: activeRootDir,
        fetchTelegramFile,
        imageStorage,
        overwrite: true,
      });
    }
    return buildDatabaseOnlyThoughtWriteResult(batch, kind);
  }

  if (kind === 'thought_delete' || kind === 'thought_move') {
    return buildDatabaseOnlyThoughtWriteResult(batch, kind);
  }

  throw new Error(`Unsupported thought batch kind: ${kind}`);
}

function buildDatabaseOnlyThoughtWriteResult(batch, kind) {
  const thought =
    batch.thought ??
    batch.thoughtEdit ??
    batch.thoughtDelete ??
    batch.thoughtMove ??
    {};
  const thoughtModule = normalizeThoughtModuleOrNull(thought.thoughtModule);
  const sourceChannel = thought.sourceChannel ?? batch.sourceChannel;
  return {
    changed: false,
    status: `${kind}_database_only`,
    postPath: null,
    photoPaths: null,
    deletedPhotoPaths: [],
    thoughtModule,
    tags: thoughtModule ? getThoughtModuleTags(thoughtModule, { sourceChannel }) : null,
  };
}
