import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as domainTraining from '../src/domain/training/index.mjs';
import * as telegram from '../src/telegram/index.mjs';
import * as site from '../src/site/index.mjs';
import * as db from '../src/db/index.mjs';
import * as jobs from '../src/jobs/index.mjs';

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

test('src boundary entry points exist and re-export expected modules', () => {
  assert.ok(domainTraining.parseTrainingRecord);
  assert.ok(domainTraining.buildTrainingSnapshot);
  assert.ok(telegram.createTelegramCommandResolver);
  assert.ok(telegram.isTelegramHelpText);
  assert.ok(site.buildDashboardViewModel);
  assert.ok(db.readTrainingSnapshotFromDatabase);
  assert.ok(db.persistNormalizedBatch);
  assert.ok(jobs.runTelegramSyncJob);
  assert.ok(jobs.runGenerateTrainingDataJob);
  assert.ok(jobs.runTrainingAnalysisJob);
  assert.ok(jobs.createFilePendingStore);
  assert.ok(jobs.createJobExecutionContext);
  assert.ok(jobs.normalizeJobResult);
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

test('sync:feishu package entrypoint uses the src use case directly', async () => {
  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));

  assert.equal(packageJson.scripts['sync:feishu'], 'node src/app/use-cases/feishu-sync.use-case.mjs');
});
