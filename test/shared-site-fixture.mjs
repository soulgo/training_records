import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const lockDir = path.join(rootDir, '.tmp', 'site-fixture.lock');
const lockWaitTimeoutMs = 300_000;
const staleLockMs = 600_000;
const lockRetryMs = 100;
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
    content: existsSync(filePath) ? readFileSync(filePath, 'utf8') : null,
  }));
}

function restoreFiles(snapshot) {
  for (const { filePath, content } of snapshot) {
    if (content === null) {
      rmSync(filePath, { force: true });
      continue;
    }

    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }
}

function releaseFixture(sourceDataSnapshot) {
  restoreFiles(sourceDataSnapshot);
  rmSync(lockDir, { recursive: true, force: true });
}

function acquireLock() {
  mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + lockWaitTimeoutMs;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
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

function removeStaleLock() {
  if (!existsSync(lockDir)) {
    return;
  }

  const ageMs = Date.now() - statSync(lockDir).mtimeMs;
  if (ageMs > staleLockMs) {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
