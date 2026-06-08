#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { DERIVED_DATA_PATTERNS, filterDerivedDataPaths } from './lib/derived-data-paths.mjs';

const execFileAsync = promisify(execFile);

export async function checkDerivedDataMerge(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const base = resolveBase(argv);
  const head = resolveHead(argv);

  await ensureGitRef(base, { cwd });
  await ensureGitRef(head, { cwd });

  const changedPaths = await gitLines(['diff', '--name-only', `${base}...${head}`], { cwd });
  const derivedPaths = filterDerivedDataPaths(changedPaths);

  if (derivedPaths.length === 0) {
    stdout.write(`No protected derived data changes found between ${base} and ${head}.\n`);
    return { ok: true, base, head, derivedPaths };
  }

  stderr.write([
    `Protected derived data changed between ${base} and ${head}:`,
    ...derivedPaths.map((item) => `- ${item}`),
    '',
    'Keep main data during dev -> main merges. Use npm run merge:dev-to-main, or restore these paths from main before opening the PR.',
    `Protected patterns: ${DERIVED_DATA_PATTERNS.join(', ')}`,
    '',
  ].join('\n'));
  return { ok: false, base, head, derivedPaths };
}

function resolveBase(argv) {
  return resolveFlagValue(argv, '--base') ?? 'origin/main';
}

function resolveHead(argv) {
  return resolveFlagValue(argv, '--head') ?? 'HEAD';
}

function resolveFlagValue(argv, name) {
  const equals = argv.find((item) => item.startsWith(`${name}=`));
  if (equals) {
    return equals.slice(name.length + 1);
  }
  const index = argv.indexOf(name);
  if (index >= 0) {
    return argv[index + 1];
  }
  return null;
}

async function ensureGitRef(ref, { cwd }) {
  if (!ref) {
    throw new Error('missing git ref');
  }
  await execFileAsync('git', ['-c', 'core.quotePath=false', 'rev-parse', '--verify', `${ref}^{commit}`], { cwd });
}

async function gitLines(args, { cwd }) {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  const result = await checkDerivedDataMerge();
  if (!result.ok) {
    process.exitCode = 1;
  }
}
