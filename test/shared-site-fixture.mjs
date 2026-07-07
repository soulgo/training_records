import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const lockDir = path.join(rootDir, '.tmp', 'site-fixture.lock');
const lockWaitTimeoutMs = 300_000;
const staleLockMs = 600_000;
const lockRetryMs = 100;
const fileRetryMs = 100;
const fileRetryAttempts = 300;
const retryableFileErrorCodes = new Set(['UNKNOWN', 'EBUSY', 'EPERM']);
const generatedSourceDataPaths = [
  path.join(rootDir, 'source', '_data', 'training.json'),
  path.join(rootDir, 'source', '_data', 'dashboardView.json'),
  path.join(rootDir, 'source', '_data', 'monitorView.json'),
  path.join(rootDir, 'source', '_data', 'actionMonitorView.json'),
  path.join(rootDir, 'source', '_data', 'body-metrics.json'),
];

export function withSharedSiteFixture(run) {
  acquireLock();
  const sourceDataSnapshot = snapshotFiles(generatedSourceDataPaths);
  try {
    const result = run();
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(() => releaseFixture(sourceDataSnapshot));
    }
    releaseFixture(sourceDataSnapshot);
    return result;
  } catch (error) {
    releaseFixture(sourceDataSnapshot);
    throw error;
  }
}

function snapshotFiles(filePaths) {
  return filePaths.map((filePath) => ({
    filePath,
    content: readFixtureFile(filePath),
  }));
}

function restoreFiles(snapshot) {
  for (const { filePath, content } of snapshot) {
    restoreFixtureFile(filePath, content);
  }
}

export function readFixtureFile(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  return runFileOperationWithRetry(() => readFileSync(filePath, 'utf8'));
}

export function restoreFixtureFile(filePath, content) {
  if (content === null) {
    runFileOperationWithRetry(() => rmSync(filePath, { force: true }));
    return;
  }

  if (readFixtureFile(filePath) === content) {
    return;
  }

  writeFixtureFile(filePath, content);
}

export function writeFixtureFile(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  runFileOperationWithRetry(() => writeFileSync(filePath, content, 'utf8'));
}

function runFileOperationWithRetry(operation) {
  for (let attempt = 0; attempt < fileRetryAttempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!retryableFileErrorCodes.has(error?.code) || attempt === fileRetryAttempts - 1) {
        throw error;
      }
      sleep(fileRetryMs);
    }
  }
}

function releaseFixture(sourceDataSnapshot) {
  let releaseError;

  try {
    restoreFiles(sourceDataSnapshot);
  } catch (error) {
    releaseError = error;
  }

  try {
    runFileOperationWithRetry(() => rmSync(lockDir, { recursive: true, force: true }));
  } catch (error) {
    releaseError ??= error;
  }

  if (releaseError) {
    throw releaseError;
  }
}

function acquireLock() {
  mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + lockWaitTimeoutMs;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      try {
        waitForGeneratedSourceDataFiles();
      } catch (error) {
        runFileOperationWithRetry(() => rmSync(lockDir, { recursive: true, force: true }));
        throw error;
      }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }

      removeStaleLock();
      sleep(lockRetryMs);
    }
  }

  throw new Error(`Timed out waiting for shared site fixture lock: ${lockDir}`);
}

function waitForGeneratedSourceDataFiles() {
  for (const filePath of generatedSourceDataPaths) {
    if (!existsSync(filePath)) {
      continue;
    }

    runFileOperationWithRetry(() => {
      const descriptor = openSync(filePath, 'r+');
      closeSync(descriptor);
    });
  }
}

function removeStaleLock() {
  if (!existsSync(lockDir)) {
    return;
  }

  const ageMs = Date.now() - statSync(lockDir).mtimeMs;
  if (ageMs > staleLockMs) {
    runFileOperationWithRetry(() => rmSync(lockDir, { recursive: true, force: true }));
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
