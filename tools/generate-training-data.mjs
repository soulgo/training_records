import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTrainingRecord } from './training-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const recordPath = path.join(rootDir, '训练记录.md');
const outputDir = path.join(rootDir, 'source', '_data');
const outputPath = path.join(outputDir, 'training.json');

const markdown = await readFile(recordPath, 'utf8');
const parsed = parseTrainingRecord(markdown);

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

process.stdout.write(`Generated ${path.relative(rootDir, outputPath)}\n`);
