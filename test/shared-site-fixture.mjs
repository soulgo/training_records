import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const lockDir = path.join(rootDir, '.tmp', 'site-fixture.lock');
const staleLockMs = 120_000;

export function withSharedSiteFixture(run) {
  acquireLock();
  try {
    return run();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function acquireLock() {
  mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }

      removeStaleLock();
      sleep(100);
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
