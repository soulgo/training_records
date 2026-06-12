#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { filterDerivedDataPaths, isDerivedDataPath } from './lib/derived-data-paths.mjs';

const execFileAsync = promisify(execFile);

export async function mergeDevToMain(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const sourceBranch = resolveFlagValue(argv, '--source') ?? 'dev';
  const targetBranch = resolveFlagValue(argv, '--target') ?? 'main';
  const message = resolveFlagValue(argv, '--message') ?? `Merge branch '${sourceBranch}' into ${targetBranch}`;

  const currentBranch = await gitText(['branch', '--show-current'], { cwd });
  if (currentBranch !== targetBranch) {
    throw new Error(`merge:dev-to-main must run on ${targetBranch}; current branch is ${currentBranch || '(detached)'}`);
  }

  const initialStatus = await gitLines(['status', '--porcelain'], { cwd });
  if (initialStatus.length > 0) {
    throw new Error('working tree must be clean before merging dev into main');
  }

  const mainCommit = await gitText(['rev-parse', 'HEAD'], { cwd });
  await ensureGitRef(sourceBranch, { cwd });

  if (await isAncestor(sourceBranch, 'HEAD', { cwd })) {
    stdout.write(`${sourceBranch} is already merged into ${targetBranch}; nothing to do.\n`);
    return {
      status: 'up_to_date',
      committed: false,
      mainCommit,
      sourceBranch,
      targetBranch,
      protectedPaths: [],
    };
  }

  let mergeFailed = false;
  try {
    await git(['merge', '--no-commit', '--no-ff', sourceBranch], { cwd });
  } catch (error) {
    mergeFailed = true;
    stderr.write(String(error.stderr || error.message || error));
    if (!String(error.stderr ?? '').endsWith('\n')) {
      stderr.write('\n');
    }
  }

  const changedPaths = await gitLines(['diff', '--name-only', 'HEAD'], { cwd });
  const stagedPaths = await gitLines(['diff', '--cached', '--name-only'], { cwd });
  const unmergedPaths = await gitLines(['diff', '--name-only', '--diff-filter=U'], { cwd });
  const allTouchedPaths = [...new Set([...changedPaths, ...stagedPaths, ...unmergedPaths])].sort();
  const derivedPaths = filterDerivedDataPaths(allTouchedPaths);

  await restoreMainDerivedPaths({
    cwd,
    mainCommit,
    derivedPaths,
    allTouchedPaths,
  });

  const remainingUnmerged = (await gitLines(['diff', '--name-only', '--diff-filter=U'], { cwd }))
    .filter((item) => !isDerivedDataPath(item));

  if (remainingUnmerged.length > 0) {
    stderr.write([
      'Non-data merge conflicts remain. Resolve these paths, then commit the merge:',
      ...remainingUnmerged.map((item) => `- ${item}`),
      '',
    ].join('\n'));
    return {
      status: 'conflicts',
      committed: false,
      mainCommit,
      sourceBranch,
      targetBranch,
      protectedPaths: derivedPaths,
      conflicts: remainingUnmerged,
    };
  }

  await git(['commit', '-m', message], { cwd });
  const mergeCommit = await gitText(['rev-parse', 'HEAD'], { cwd });
  const protectedMessage = derivedPaths.length > 0
    ? `Protected main data paths: ${derivedPaths.length}`
    : 'No protected data paths changed.';
  stdout.write(`Merged ${sourceBranch} into ${targetBranch} as ${mergeCommit}.\n${protectedMessage}\n`);

  return {
    status: mergeFailed ? 'merged_after_data_conflicts' : 'merged',
    committed: true,
    mainCommit,
    mergeCommit,
    sourceBranch,
    targetBranch,
    protectedPaths: derivedPaths,
  };
}

async function restoreMainDerivedPaths({ cwd, mainCommit, derivedPaths, allTouchedPaths }) {
  const possiblyDeletedDerivedPaths = filterDerivedDataPaths(allTouchedPaths);
  const pathsToRestore = [...new Set([...derivedPaths, ...possiblyDeletedDerivedPaths])].sort();
  if (pathsToRestore.length === 0) {
    return;
  }

  const trackedOnMain = new Set(await gitLines(['ls-tree', '-r', '--name-only', mainCommit, '--', ...pathsToRestore], { cwd }));
  const restorePaths = pathsToRestore.filter((item) => trackedOnMain.has(item));
  const removePaths = pathsToRestore.filter((item) => !trackedOnMain.has(item));

  if (restorePaths.length > 0) {
    await git(['checkout', mainCommit, '--', ...restorePaths], { cwd });
    await git(['add', '--', ...restorePaths], { cwd });
  }

  if (removePaths.length > 0) {
    await git(['rm', '-r', '-f', '--ignore-unmatch', '--', ...removePaths], { cwd });
  }
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
  await execFileAsync('git', ['-c', 'core.quotePath=false', 'rev-parse', '--verify', `${ref}^{commit}`], { cwd });
}

async function isAncestor(ancestor, descendant, { cwd }) {
  try {
    await git(['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function git(args, { cwd }) {
  return execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function gitText(args, { cwd }) {
  const { stdout } = await git(args, { cwd });
  return stdout.trim();
}

async function gitLines(args, { cwd }) {
  const text = await gitText(args, { cwd });
  return text ? text.split(/\r?\n/u).filter(Boolean) : [];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  try {
    await mergeDevToMain();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
