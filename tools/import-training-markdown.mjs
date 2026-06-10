import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importTrainingMarkdownToDatabase } from './training-db-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export async function importTrainingMarkdown(options = {}) {
  const activeRootDir = options.rootDir ?? rootDir;
  const markdownPath = options.markdownPath ?? path.join(activeRootDir, '训练记录.md');
  const markdown = await readFile(markdownPath, 'utf8');
  return importTrainingMarkdownToDatabase({
    markdown,
    env: options.env ?? process.env,
    createClient: options.createClient,
    processedAt: options.processedAt,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await importTrainingMarkdown();
}
