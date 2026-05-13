import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importTrainingMarkdownToDatabase } from './training-db-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export async function reconcileTrainingMarkdownToCore(options = {}) {
  const activeRootDir = options.rootDir ?? rootDir;
  const markdownPath = options.markdownPath ?? path.join(activeRootDir, '训练记录.md');
  const stderr = options.stderr ?? process.stderr;
  const importMarkdown =
    options.importTrainingMarkdownToDatabase ?? importTrainingMarkdownToDatabase;
  const markdown = await readFile(markdownPath, 'utf8');

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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = await reconcileTrainingMarkdownToCore();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
