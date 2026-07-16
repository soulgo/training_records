import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTrainingSnapshot } from '../src/domain/training/training-snapshot.mjs';
import { parseTrainingRecord } from '../src/domain/training/training-parser.mjs';
import { buildDashboardViewModel } from '../src/site/dashboard-view.mjs';
import { createTelegramCommandResolver } from '../src/telegram/command-registry.mjs';
import { isTelegramHelpText } from '../src/telegram/help.mjs';
import { readTrainingSnapshotFromDatabase } from '../src/db/training/read.mjs';
import { persistNormalizedBatch } from '../src/db/training/write.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIRST_PARTY_BOUNDARY_ROOTS = [
  'src',
  'tools',
  'cloudflare',
  path.join('.github', 'workflows'),
];
const FIRST_PARTY_BOUNDARY_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.mjs', '.yaml', '.yml']);
const DEPRECATED_NODE_API_PATTERNS = [
  {
    label: 'url.parse()',
    pattern: /\b(?:nodeURL|url)\s*\.\s*parse\s*\(/,
  },
  {
    label: 'require("url").parse()',
    pattern: /\brequire\s*\(\s*['"](?:node:)?url['"]\s*\)\s*\.\s*parse\s*\(/,
  },
  {
    label: 'import { parse } from "url"',
    pattern: /\bimport\s*\{[^}]*\bparse\b[^}]*\}\s*from\s*['"](?:node:)?url['"]/,
  },
  {
    label: 'const { parse } = require("url")',
    pattern: /\bconst\s*\{[^}]*\bparse\b[^}]*\}\s*=\s*require\s*\(\s*['"](?:node:)?url['"]\s*\)/,
  },
  {
    label: 'Node built-in punycode import',
    pattern: /\b(?:import\s*\(\s*|require\s*\(\s*)['"](?:node:)?punycode['"]\s*\)/,
  },
  {
    label: 'Node built-in punycode static import',
    pattern: /\b(?:from\s*|import\s*)['"](?:node:)?punycode['"]/,
  },
];

function collectFirstPartyBoundaryFiles() {
  const files = [];

  function visit(currentPath) {
    const currentStat = statSync(currentPath);
    if (currentStat.isDirectory()) {
      for (const dirent of readdirSync(currentPath, { withFileTypes: true })) {
        if (dirent.name === 'node_modules') continue;
        visit(path.join(currentPath, dirent.name));
      }
      return;
    }

    if (currentStat.isFile() && FIRST_PARTY_BOUNDARY_EXTENSIONS.has(path.extname(currentPath))) {
      files.push(currentPath);
    }
  }

  for (const relativeRoot of FIRST_PARTY_BOUNDARY_ROOTS) {
    visit(path.join(REPO_ROOT, relativeRoot));
  }

  return files;
}

test('production boundary modules expose the maintained behavior directly', () => {
  assert.equal(typeof parseTrainingRecord, 'function');
  assert.equal(typeof buildTrainingSnapshot, 'function');
  assert.equal(typeof createTelegramCommandResolver, 'function');
  assert.equal(typeof isTelegramHelpText, 'function');
  assert.equal(typeof buildDashboardViewModel, 'function');
  assert.equal(typeof readTrainingSnapshotFromDatabase, 'function');
  assert.equal(typeof persistNormalizedBatch, 'function');
});

test('first-party runtime files avoid deprecated Node URL and punycode APIs', () => {
  const files = collectFirstPartyBoundaryFiles();
  assert.ok(files.length > 0, 'expected first-party runtime files to be scanned');

  const violations = [];

  for (const filePath of files) {
    const text = readFileSync(filePath, 'utf8');
    const relativePath = path.relative(REPO_ROOT, filePath);

    for (const { label, pattern } of DEPRECATED_NODE_API_PATTERNS) {
      if (pattern.test(text)) {
        violations.push(`${relativePath}: ${label}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('src modules do not import implementation code back from tools', () => {
  const files = [];

  function visit(currentPath) {
    const currentStat = statSync(currentPath);
    if (currentStat.isDirectory()) {
      for (const dirent of readdirSync(currentPath, { withFileTypes: true })) {
        visit(path.join(currentPath, dirent.name));
      }
      return;
    }
    if (currentStat.isFile() && path.extname(currentPath) === '.mjs') {
      files.push(currentPath);
    }
  }

  visit(path.join(REPO_ROOT, 'src'));

  const violations = files
    .map((filePath) => {
      const text = readFileSync(filePath, 'utf8');
      const relativePath = path.relative(REPO_ROOT, filePath);
      return /\.\.\/\.\.\/\.\.\/tools|\.\.\/\.\.\/\.\.\/\.\.\/tools/.test(text) ? relativePath : null;
    })
    .filter(Boolean);

  assert.deepEqual(violations, []);
});

test('obsolete architecture shells and unused barrel entrypoints are removed', () => {
  const obsoletePaths = [
    'src/ai/errors.mjs',
    'src/ai/openai-compatible-provider.mjs',
    'src/ai/provider.mjs',
    'src/ai/recognition-service.mjs',
    'src/ai/schema-validator.mjs',
    'src/adapters/postgres/training-write.facade.mjs',
    'src/adapters/postgres/schema-preflight.pg.mjs',
    'src/app/use-cases/telegram-sync/fallback.mjs',
    'src/core/index.mjs',
    'src/db/index.mjs',
    'src/db/training/core-row-writer.mjs',
    'src/db/training/index.mjs',
    'src/db/training/incremental-write.mjs',
    'src/domain/index.mjs',
    'src/domain/telegram/index.mjs',
    'src/domain/training/index.mjs',
    'src/infra/app-factory.mjs',
    'src/infra/config.mjs',
    'src/jobs/index.mjs',
    'src/jobs/generate-training-data-job.mjs',
    'src/jobs/pending-store.mjs',
    'src/jobs/service-adapter-contract.mjs',
    'src/jobs/telegram-sync-job.mjs',
    'src/jobs/training-analysis-job.mjs',
    'src/shared/index.mjs',
    'src/site/index.mjs',
    'src/site/view-model-notes.mjs',
    'src/telegram/sync-batch.mjs',
    'src/telegram/sync.mjs',
    'tools/dashboard-view.mjs',
    'tools/feishu-sync.mjs',
    'tools/generate-training-data.mjs',
    'tools/lib/markdown-render.mjs',
    'tools/lib/snapshot-fallback.mjs',
    'tools/lib/thought-modules.mjs',
    'tools/monitor-view.mjs',
    'tools/prompt-generator.mjs',
    'tools/telegram-recognition-schema.mjs',
    'tools/telegram-sync-dates.mjs',
    'tools/telegram-sync-image-processing.mjs',
    'tools/telegram-sync-lib.mjs',
    'tools/telegram-sync-markdown.mjs',
    'tools/telegram-sync-status.mjs',
    'tools/telegram-sync.mjs',
    'tools/telegram-sync-fallback.mjs',
    'tools/telegram-thoughts.mjs',
    'tools/telegram-transport.mjs',
    'tools/training-analysis-focus.mjs',
    'tools/training-analysis-request.mjs',
    'tools/training-analysis-summary.mjs',
    'tools/training-analysis.mjs',
    'tools/training-db-archive.mjs',
    'tools/training-db-config.mjs',
    'tools/training-db-core.mjs',
    'tools/training-db-read.mjs',
    'tools/training-db-write.mjs',
    'tools/training-domain.mjs',
    'tools/training-parser.mjs',
    'tools/training-prompt.mjs',
    'tools/training-snapshot.mjs',
    'runtime/telegram-sync-pending.ndjson',
  ];

  assert.deepEqual(
    obsoletePaths.filter((relativePath) => existsSync(path.join(REPO_ROOT, relativePath))),
    [],
  );
});

test('sync:feishu package entrypoint uses the src use case directly', async () => {
  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));

  assert.equal(packageJson.scripts['sync:feishu'], 'node src/app/use-cases/feishu-sync.use-case.mjs');
});
