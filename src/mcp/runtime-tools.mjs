import path from 'node:path';

import { getTelegramCommandRegistry } from '../telegram/command-registry.mjs';
import {
  parsePromptMetadata,
  publicConfigKeys,
  readNdjson,
  safeReadTextFile,
  secretKeyPattern,
  summarizeErrorValue,
  toPortableRelativePath,
} from './tool-support.mjs';

export async function getConfigTool(args, context) {
  const requested = Array.isArray(args.keys) && args.keys.length
    ? args.keys
    : [...publicConfigKeys];
  const config = {};
  for (const key of requested) {
    if (!publicConfigKeys.has(key) || secretKeyPattern.test(key)) {
      continue;
    }
    if (context.env[key] !== undefined) {
      config[key] = String(context.env[key]);
    }
  }
  return {
    data: { config },
    source: 'env',
  };
}

export async function getRuntimeStatusTool(args, context) {
  const pending = await readNdjson(path.join(context.rootDir, 'runtime', 'telegram-sync-pending.ndjson'));
  const archiveFailures = await readNdjson(path.join(context.rootDir, 'runtime', 'training-db-sync.ndjson'));
  const limit = args.limit ?? 5;
  const data = {
    pendingCount: pending.valid.length,
    pendingInvalidLines: pending.invalidLines,
    archiveFailureCount: archiveFailures.valid.length,
    archiveFailureInvalidLines: archiveFailures.invalidLines,
  };
  if (args.include_recent_errors) {
    data.recentErrors = [...pending.valid, ...archiveFailures.valid]
      .slice(-limit)
      .map((entry) => ({
        failedAt: entry.failedAt ?? entry.runFinishedAt ?? null,
        error: summarizeErrorValue(entry.error ?? entry),
        batchId: entry.batch?.batchId ?? null,
      }));
  }
  return {
    data,
    source: 'runtime',
  };
}

export async function getTelegramCommandRegistryTool() {
  return {
    data: {
      commands: getTelegramCommandRegistry().map((command) => ({
        name: command.name,
        priority: command.priority,
        aliases: command.aliases,
      })),
    },
    source: 'telegram_registry',
  };
}

export async function getPromptMetadataTool(args, context) {
  const promptPath = args.prompt_type === 'analysis'
    ? context.env.TRAINING_ANALYSIS_PROMPT_PATH || path.join(context.rootDir, 'prompts', 'training-analysis.md')
    : context.env.TELEGRAM_RECOGNITION_PROMPT_PATH || path.join(context.rootDir, 'prompts', 'telegram-training-image-recognition.md');
  const prompt = await safeReadTextFile(promptPath);
  const metadata = parsePromptMetadata(prompt);
  return {
    data: {
      promptType: args.prompt_type,
      path: toPortableRelativePath(path.relative(context.rootDir, promptPath)),
      metadata,
    },
    source: 'prompt',
  };
}
